const fetch = require("node-fetch");
const fs = require("fs");
const childProcess = require("child_process");
const process = require("process");
const path = require("path");
const moment = require("moment");
const crypto = require("crypto");
const _ = require("lodash");
const { CONFIG_FOLDER } = require('./definitions');
const { writeJsonFile, readJsonFile } = require('./helpers/files');


// from: https://app.youneedabudget.com/settings/developer
const YNAB_PERSONAL_TOKEN = allCredentials.ynab.devToken;
// from: https://api.youneedabudget.com/v1/budgets
const YNAB_BUDGET_ID = allCredentials.ynab.budgetId;

const root = childProcess
  .execSync("git rev-parse --show-toplevel")
  .toString()
  .trim();
const dataDir = path.join(root, "output", "data");

const importIdsCounts = {};
function getImportId({ date, payee, amount }) {
  let dateMoment = moment(date, "YYYY-MM-DD", true);
  const daysPassed = dateMoment.diff(moment([2000, 0, 1]), "days");
  const payeeHash = crypto
    .createHash("md5")
    .update(payee)
    .digest("base64")
    .toString();

  const importIdPrefix = daysPassed + payeeHash + amount;
  if (importIdsCounts[importIdPrefix] === undefined) {
    importIdsCounts[importIdPrefix] = 0;
  } else {
    importIdsCounts[importIdPrefix]++;
  }

  let importId = importIdPrefix + importIdsCounts[importIdPrefix];
  if (importId.length > 35) {
    importId = importId.slice(0, 35);
  }

  return importId;
}

function processAmount(amount) {
  let processedAmount = undefined;
  if (_.isNumber(amount)) {
    processedAmount = amount;
  } else if (_.isString(amount)) {
    if (amount.includes("$")) {
      throw new Error(
        `dollar sign found - all values are expected to be in ILS`
      );
    }

    processedAmount = _filterFloat(amount.replace(/[^\d.-]/g, ""));
    if (_.isNaN(this.amount)) {
      throw new Error(`invalid amount value: ${amount}`);
    }
  } else {
    throw new Error(`invalid amount value: ${amount}`);
  }

  return processedAmount;
}

function _filterFloat(value) {
  if (/^(\-|\+)?([0-9]+(\.[0-9]+)?|Infinity)$/.test(value))
    return Number(value);
  return NaN;
}

async function processAccount(accountName) {
  let accountPath = `${dataDir}/${accountName}.json`;

  console.log(`Processing account ${accountName}... `);
  const transactions = JSON.parse(fs.readFileSync(accountPath));

  const accountId = allCredentials[accountName].ynabAccountId;

  const byBillingDate = _.groupBy(transactions, tx => tx.billingDate);
  const adjustedTransactions = Object.entries(byBillingDate)
    .flatMap(([billingDate, transactions]) => {
      let formattedTransactions = undefined;

      let billingMoment = undefined;
      let fakeTxMoment = undefined;

      // Banks don't have billing dates
      if (accountName !== "bank") {
        billingMoment = moment(billingDate, "YYYY-MM-DD", true);
        if (!billingMoment.isValid()) {
          throw new Error(`Invalid billing moment for date:` + billingDate);
        }

        // Used for split transactions
        fakeTxMoment = moment(billingMoment)
          .subtract(1, "month")
          .add(3, "days");
      }

      formattedTransactions = transactions.map(tx => {
        let noteParts = [];

        let txMoment = moment(tx.date, "YYYY-MM-DD", true);

        if (billingMoment) {
          noteParts.push(billingMoment.format("YYYY-MM-DD"));
        }

        if (fakeTxMoment && tx.memo.match(/תשלום\s+(\d+)/)) {
          txMoment = fakeTxMoment;
          noteParts.push(tx.memo);
        }

        let diffFromNow = moment().diff(txMoment);
        if (diffFromNow > 0) {
          return {
            ...tx,
            date: txMoment.format("YYYY-MM-DD"),
            memo: noteParts.join(" - "),
            amount: processAmount(tx.amount)
          };
        } else {
          console.warn("Skipping future transactions: " + JSON.stringify(tx));
          return undefined;
        }
      });

      return formattedTransactions;
    })
    .filter(tx => !!tx);

  const body = adjustedTransactions.map(transaction => {
    const amountNumber = Math.round(parseFloat(transaction.amount) * -1000);
    return {
      account_id: accountId,
      date: transaction.date,
      // Slice per max-length at: https://api.youneedabudget.com/v1#/Transactions
      payee_name: transaction.payee.slice(0, 50),
      memo: transaction.memo.slice(0, 200),
      amount: amountNumber,
      import_id: getImportId({ ...transaction, amount: amountNumber })
    };
  });

  const response = await fetch(
    `https://api.youneedabudget.com/v1/budgets/${YNAB_BUDGET_ID}/transactions`,
    {
      credentials: "include",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${YNAB_PERSONAL_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        transactions: body
      }),
      method: "POST",
      mode: "cors"
    }
  );
  const responseJson = await response.json();
  if (responseJson.data && responseJson.data.transactions) {
    const newTransactions = responseJson.data.transactions.length;

    const dateMoments = _.orderBy(
      transactions.map(transaction =>
        moment(transaction.date, "YYYY-MM-DD", true)
      ),
      moment => -moment.valueOf()
    );

    const metadata = {
      lastExtractionSuccess: moment(fs.statSync(accountPath).mtime),
      lastTransactionDate: dateMoments[0]
    };

    return {
      newTransactions,
      lastDateMoment: dateMoments[0],
      metadata: metadata
    };
  } else {
    throw new Error(
      "Error response from YNAB: \n" + JSON.stringify(responseJson, null, 2)
    );
  }
}

function processReportCypress(reportPath) {
  const report = JSON.parse(fs.readFileSync(reportPath));
  const date = report.stats.end;

  return report.results
    .flatMap(result => result.suites)
    .flatMap(suit => suit.tests)
    .map(test => ({ title: test.fullTitle, success: test.pass, date: date }));
}

function updateHistoryFromReports() {
  const reportsDir = path.join(root, "output", "reports");
  const reports = fs
    .readdirSync(reportsDir)
    .filter(file => file.endsWith(".json"));

  const results = [];
  for (const report of reports) {
    const fullPath = path.join(reportsDir, report);
    if (report.includes("cypress")) {
      results.push(...processReportCypress(fullPath));
    } else {
      results.push(JSON.parse(fs.readFileSync(fullPath)));
    }
    fs.unlinkSync(fullPath);
  }
  console.log(JSON.stringify(results, null, 2));

  const historyPath = path.join(root, "output", "history.json");
  const historyData = [];
  if (fs.existsSync(historyPath)) {
    historyData.push(...JSON.parse(fs.readFileSync(historyPath)));
  }

  historyData.push(...results);
  fs.writeFileSync(historyPath, JSON.stringify(historyData, null, 2));
}

function getUnsuccessfulExtractions() {
  let historyData = [];
  const historyPath = path.join(root, "output", "history.json");
  if (fs.existsSync(historyPath)) {
    historyData = JSON.parse(fs.readFileSync(historyPath));
  }
  const groupedLog = _.groupBy(historyData, a => a.title);
  const unsuccessfulMessages = Object.keys(groupedLog)
    .map(accountName => {
      const sortedEntries = groupedLog[accountName]
        .map(item => ({ ...item, date: moment(item.date) }))
        .filter(item => item.success === true)
        .sort(item => -item.date.valueOf());

      if (moment().diff(sortedEntries[0].date, "hours") > 72) {
        return `Account "${accountName}" last ran successfully ${sortedEntries[0].date.fromNow()}`;
      }
    })
    .filter(item => !!item);

  return unsuccessfulMessages;
}

async function main() {
  const results = [];

  try {
    updateHistoryFromReports();
  } catch (e) {
    console.error("Failed to process reports: ", e);
  }

  const accountNames = fs
    .readdirSync(dataDir)
    .filter(file => file.endsWith(".json"))
    .map(file => path.basename(file, ".json"));
  for (const accountName of accountNames) {
    let result = await processAccount(accountName);
    console.log(JSON.stringify(result, null, 2));
    results.push({ accountName, ...result });
  }

  const totalNew = _.sumBy(results, result => result.newTransactions);
  const late = results
    .filter(result => moment().diff(result.lastDateMoment, "days") > 72)
    .map(
      result =>
        `Account "${
          result.accountName
        }" last updated ${result.lastDateMoment.fromNow()}`
    );

  const unsuccessfulMessages = getUnsuccessfulExtractions();
  if (totalNew > 0) {
    let message = `There are ${totalNew} new transactions.`;

    if (unsuccessfulMessages.length > 0) {
      message += `\n\n` + unsuccessfulMessages.join("\n");
    }

    // if (late.length > 0) {
    //   message += `\n\n` + late.join("\n");
    // }

    console.log("");
    console.log(message);

    childProcess
      .execSync(`/usr/local/bin/pb push -d 0 '${message}'`)
      .toString()
      .trim();
  }
}

main();
