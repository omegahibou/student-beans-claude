// ── Account Manager ───────────────────────────────────────────────────────────
// Accounts are stored in Railway env vars as:
//   SB_ACCOUNT_1_NAME, SB_ACCOUNT_1_COOKIES
//   SB_ACCOUNT_2_NAME, SB_ACCOUNT_2_COOKIES  ...etc
// RAILWAY_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_SERVICE_ID, RAILWAY_ENVIRONMENT_ID
// must be set for Railway sync to work.

const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

// ── Load accounts from env vars ───────────────────────────────────────────────
function loadAccounts() {
  const accounts = [];
  for (let i = 1; i <= 20; i++) {
    const name = process.env[`SB_ACCOUNT_${i}_NAME`];
    const cookies = process.env[`SB_ACCOUNT_${i}_COOKIES`];
    if (name && cookies) {
      accounts.push({ index: i, name, cookies, status: 'unknown' });
    }
  }
  return accounts;
}

// ── Railway GraphQL API ───────────────────────────────────────────────────────
async function railwayRequest(query, variables) {
  const token = process.env.RAILWAY_TOKEN;
  if (!token) throw new Error('RAILWAY_TOKEN not set');

  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

// ── Upsert a single env var on Railway ───────────────────────────────────────
async function setEnvVar(name, value) {
  const query = `
    mutation UpsertVariable($input: VariableUpsertInput!) {
      variableUpsert(input: $input)
    }
  `;
  await railwayRequest(query, {
    input: {
      projectId: process.env.RAILWAY_PROJECT_ID,
      serviceId: process.env.RAILWAY_SERVICE_ID,
      environmentId: process.env.RAILWAY_ENVIRONMENT_ID || 'b1837f81-32a3-4096-954b-995ea500d571',
      name,
      value,
    },
  });
}

// ── Delete a single env var on Railway ───────────────────────────────────────
async function deleteEnvVar(name) {
  const query = `
    mutation DeleteVariable($input: VariableDeleteInput!) {
      variableDelete(input: $input)
    }
  `;
  await railwayRequest(query, {
    input: {
      projectId: process.env.RAILWAY_PROJECT_ID,
      serviceId: process.env.RAILWAY_SERVICE_ID,
      environmentId: process.env.RAILWAY_ENVIRONMENT_ID || 'b1837f81-32a3-4096-954b-995ea500d571',
      name,
    },
  });
}

// ── Trigger a redeploy ────────────────────────────────────────────────────────
async function triggerRedeploy() {
  const query = `
    mutation Redeploy($serviceId: String!, $environmentId: String!) {
      serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
    }
  `;
  await railwayRequest(query, {
    serviceId: process.env.RAILWAY_SERVICE_ID,
    environmentId: process.env.RAILWAY_ENVIRONMENT_ID || 'b1837f81-32a3-4096-954b-995ea500d571',
  });
}

// ── Find the next free account slot ──────────────────────────────────────────
function nextFreeIndex(accounts) {
  const used = new Set(accounts.map(a => a.index));
  for (let i = 1; i <= 20; i++) {
    if (!used.has(i)) return i;
  }
  throw new Error('Maximum 20 accounts reached');
}

// ── Add account ───────────────────────────────────────────────────────────────
async function addAccount(name, cookies) {
  const accounts = loadAccounts();
  const idx = nextFreeIndex(accounts);
  await setEnvVar(`SB_ACCOUNT_${idx}_NAME`, name);
  await setEnvVar(`SB_ACCOUNT_${idx}_COOKIES`, cookies);
  // Update in-memory env so it's available without restart
  process.env[`SB_ACCOUNT_${idx}_NAME`] = name;
  process.env[`SB_ACCOUNT_${idx}_COOKIES`] = cookies;
  return idx;
}

// ── Remove account ────────────────────────────────────────────────────────────
async function removeAccount(index) {
  await deleteEnvVar(`SB_ACCOUNT_${index}_NAME`);
  await deleteEnvVar(`SB_ACCOUNT_${index}_COOKIES`);
  delete process.env[`SB_ACCOUNT_${index}_NAME`];
  delete process.env[`SB_ACCOUNT_${index}_COOKIES`];
}

// ── Rename account ────────────────────────────────────────────────────────────
async function renameAccount(index, newName) {
  await setEnvVar(`SB_ACCOUNT_${index}_NAME`, newName);
  process.env[`SB_ACCOUNT_${index}_NAME`] = newName;
}

// ── Update cookies ────────────────────────────────────────────────────────────
async function updateCookies(index, cookies) {
  await setEnvVar(`SB_ACCOUNT_${index}_COOKIES`, cookies);
  process.env[`SB_ACCOUNT_${index}_COOKIES`] = cookies;
}

// ── Test an account's cookies ─────────────────────────────────────────────────
async function testAccount(index) {
  const sb = require('./studentbeans');
  const cookies = process.env[`SB_ACCOUNT_${index}_COOKIES`];
  if (!cookies) return 'no_cookies';
  try {
    const result = await sb.testCookies(cookies);
    return result ? 'ok' : 'expired';
  } catch (e) {
    return 'error';
  }
}

module.exports = { loadAccounts, addAccount, removeAccount, renameAccount, updateCookies, testAccount, triggerRedeploy };
