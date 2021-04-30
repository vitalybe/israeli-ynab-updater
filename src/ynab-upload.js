/* eslint-disable */
const fetch = require('node-fetch');
const fs = require('fs');
const childProcess = require('child_process');
const path = require('path');
const moment = require('moment');
const crypto = require('crypto');
const _ = require('lodash');
const { CONFIG_FOLDER, DOWNLOAD_FOLDER } = require('./definitions');
const { writeJsonFile, readJsonFile } = require('./helpers/files');

const REPORT_FOLDER = path.join(DOWNLOAD_FOLDER, 'tasks/Monthly');
const HISTORY_FILE = path.join(CONFIG_FOLDER, 'history.json');

let vitalyYnabConfig;

const importIdsCounts = {};

function getImportId({ date, payee, amount }) {
  const dateMoment = moment(date, 'YYYY-MM-DD', true);
  const daysPassed = dateMoment.diff(moment([2000, 0, 1]), 'days');
  const payeeHash = crypto
    .createHash('md5')
    .update(payee)
    .digest('base64')
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

async function processTransactions(transactions) {

  const body = transactions.map((transaction) => {
    const amountNumber = Math.round(parseFloat(transaction.amount) * 1000);
    const ynabAccount = vitalyYnabConfig.ynabAccounts.find(account => account.id === transaction.account);
    if(!ynabAccount) {
      throw new Error(`failed to find account for transaction: ` + JSON.stringify(transaction, null, 2));
    }

    let memo = "";
    if(transaction.installment !== null || transaction.total !== null) {
      memo = `Installment: ${transaction.installment} out of ${transaction.total}`
    }

    return {
      account_id: ynabAccount.uuid,
      date: transaction.dateMoment,
      // Slice per max-length at: https://api.youneedabudget.com/v1#/Transactions
      payee_name: transaction.payee.slice(0, 50),
      memo: memo.slice(0, 200),
      amount: amountNumber,
      import_id: getImportId(Object.assign({}, transaction, { amount: amountNumber })),
    };
  });

  const response = await fetch(
    `https://api.youneedabudget.com/v1/budgets/${vitalyYnabConfig.ynab.budgetId}/transactions`,
    {
      credentials: 'include',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${vitalyYnabConfig.ynab.devToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        transactions: body,
      }),
      method: 'POST',
      mode: 'cors',
    },
  );
  const responseJson = await response.json();
  if (responseJson.data && responseJson.data.transactions) {
    const newTransactions = responseJson.data.transactions.length;

    const dateMoments = _.orderBy(
      transactions.map((transaction) => moment(transaction.date, 'YYYY-MM-DD', true)),
      (moment) => -moment.valueOf(),
    );

    return {
      totalTransactions: transactions.length,
      newTransactions,
      lastDateMoment: dateMoments[0],
    };
  }
  throw new Error(
    `Error response from YNAB: \n${JSON.stringify(responseJson, null, 2)}`,
  );
}

async function updateHistoryData(transactions) {
  let currentHistory = [];
  try {
    currentHistory = await readJsonFile(HISTORY_FILE);
    if(!currentHistory) {
      currentHistory = [];
    }
  } catch (e) {
    console.warn("failed to get history")
  }
  const groupedByAccount = _.groupBy(transactions, transaction => transaction.account)
  const runDate = moment().format();
  let newHistory = Object.keys(groupedByAccount).map(account => ({title: account, date: runDate, amount: groupedByAccount[account].length }));

  const allHistory = currentHistory.concat(newHistory)
  await writeJsonFile(HISTORY_FILE, allHistory);

  return allHistory;
}

function getUnsuccessfulExtractions(historyData) {

  const groupedLog = _.groupBy(historyData, (a) => a.title);
  const unsuccessfulMessages = Object.keys(groupedLog)
    .map((accountName) => {
      const sortedEntries = groupedLog[accountName]
        .map((item) => (Object.assign({}, item, { date: moment(item.date) })))
        .sort((item) => -item.date.valueOf());

      if (moment().diff(sortedEntries[0].date, 'hours') > 72) {
        return `Account "${accountName}" last ran successfully ${sortedEntries[0].date.fromNow()}`;
      }
      return undefined;
    })
    .filter((item) => !!item);

  return unsuccessfulMessages;
}

async function readTransactions() {
  const reports = fs
    .readdirSync(REPORT_FOLDER)
    .filter((file) => file.endsWith('.json'));

  if(reports.length !== 1) {
    throw new Error(`only 1 report is expected, but ${reports.length} found`);
  }

  return readJsonFile(path.join(REPORT_FOLDER, reports[0]));
}

async function loadYnabConfig() {
  const configSkeleton = await readJsonFile(path.join(CONFIG_FOLDER, 'vitaly-ynab.json'));
  const accountResponse = await (await fetch(
    `https://api.youneedabudget.com/v1/budgets/${configSkeleton.ynab.budgetId}/accounts`,
    {
      credentials: 'include',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${configSkeleton.ynab.devToken}`,
        'content-type': 'application/json',
      },
    },
  )).json();

  for (const ynabAccount of configSkeleton.ynabAccounts) {
    const responseAccount = accountResponse.data.accounts.find(responseAccount => responseAccount.name === ynabAccount.name);
    if(!responseAccount) {
      throw new Error(`failed to find account: ` + ynabAccount.name);
    }
    ynabAccount.uuid = responseAccount.id;
  }

  return configSkeleton;
}

async function main() {
  vitalyYnabConfig = await loadYnabConfig();
  const transactions = await readTransactions();
  let historyData = undefined;

  try {
    historyData = await updateHistoryData(transactions);
  } catch (e) {
    console.error('Failed to process history: ', e);
  }

  const result = await processTransactions(transactions);
  const totalNew = result.newTransactions;
  console.log(`Done. New transactions: ${totalNew}. Total transactions: ${transactions.length}`)

  const unsuccessfulMessages = getUnsuccessfulExtractions(historyData);
  if (totalNew > 0) {
    let message = `There are ${totalNew} new transactions.`;

    if (unsuccessfulMessages.length > 0) {
      message += `\n\n${unsuccessfulMessages.join('\n')}`;
    }

    console.log('');
    console.log(message);

    childProcess
      .execSync(`/usr/local/bin/pb push -d 0 '${message}'`)
      .toString()
      .trim();
  }
}

main();
