const $ = id => document.getElementById(id);
let session;
try { session = JSON.parse(sessionStorage.getItem('penny-session') || 'null'); } catch { session = null; }
let mode = 'login';
let nextCursor = null;
let rows = [];
let pendingCreate = session?.pendingCreate || null;
let toastTimer;
const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

function message(id, text = '') {
  $(id).textContent = text;
  $(id).hidden = !text;
}
function notice(text) {
  message('notice', text);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => message('notice'), 4500);
}
function saveSession(value) {
  session = value;
  try {
    if (value) sessionStorage.setItem('penny-session', JSON.stringify(value));
    else sessionStorage.removeItem('penny-session');
  } catch { /* The app still works when browser storage is disabled. */ }
}
function clearDashboard() {
  rows = []; nextCursor = null; pendingCreate = null;
  $('expense-list').replaceChildren(); $('expense-form').reset();
  $('total-amount').textContent = money(0); $('total-count').textContent = '0';
  $('empty-state').hidden = false; $('load-more').hidden = true;
  message('list-error'); message('expense-error');
}
function rememberPending(value) {
  pendingCreate = value;
  if (session) saveSession({ ...session, pendingCreate: value });
}
function showView() {
  $('auth-view').hidden = Boolean(session);
  $('dashboard-view').hidden = !session;
  $('logout').hidden = !session;
  if (session) $('account-email').textContent = session.user.email;
}
function setMode(value) {
  mode = value;
  $('login-tab').classList.toggle('active', mode === 'login');
  $('signup-tab').classList.toggle('active', mode === 'signup');
  $('login-tab').setAttribute('aria-pressed', String(mode === 'login'));
  $('signup-tab').setAttribute('aria-pressed', String(mode === 'signup'));
  $('auth-heading').textContent = mode === 'login' ? 'Welcome back.' : 'Your fresh start.';
  $('auth-description').textContent = mode === 'login' ? 'Sign in to pick up where you left off.' : 'Create an account and make a little room for clarity.';
  $('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('password-hint').hidden = mode === 'login';
  $('auth-submit').replaceChildren(document.createTextNode(mode === 'login' ? 'Sign in ' : 'Create account '));
  const arrow = document.createElement('span'); arrow.textContent = '→'; $('auth-submit').append(arrow);
  message('auth-error');
}
async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...options.headers }
    });
  } catch { throw new Error('Could not connect. Check your connection and try again.'); }
  let body;
  try { body = await response.json(); }
  catch { throw new Error('The service is starting or unavailable. Wait a moment and try again.'); }
  if (!response.ok) {
    if (response.status === 401 && session) {
      saveSession(null); clearDashboard(); showView();
      message('auth-error', 'Your session ended. Please sign in again.');
    }
    const text = body.fields ? Object.entries(body.fields).map(([field, problem]) => `${field}: ${problem}`).join('. ') : body.message || (body.id ? `Something went wrong. Reference: ${body.id}` : 'The request could not be completed.');
    const error = new Error(text); error.status = response.status; throw error;
  }
  return body;
}
function renderRows() {
  $('expense-list').replaceChildren();
  $('empty-state').hidden = rows.length > 0;
  for (const expense of rows) {
    const row = document.createElement('div'); row.className = 'expense-row';
    const icon = document.createElement('span'); icon.className = 'row-icon'; icon.textContent = '↗'; icon.setAttribute('aria-hidden', 'true');
    const description = document.createElement('div'); description.className = 'row-description';
    const title = document.createElement('strong'); title.textContent = expense.title;
    const date = document.createElement('small'); date.textContent = new Date(expense.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    description.append(title, date);
    const amount = document.createElement('span'); amount.className = 'row-amount'; amount.textContent = money(expense.amountCents);
    const remove = document.createElement('button'); remove.className = 'delete-button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Delete ${expense.title}`);
    let armed = false;
    remove.addEventListener('click', async () => {
      if (!armed) {
        armed = true; remove.classList.add('confirm'); remove.textContent = 'Confirm'; remove.setAttribute('aria-label', `Confirm delete ${expense.title}`);
        setTimeout(() => { if (!remove.disabled) { armed = false; remove.classList.remove('confirm'); remove.textContent = '×'; remove.setAttribute('aria-label', `Delete ${expense.title}`); } }, 4000);
        return;
      }
      remove.disabled = true; message('list-error');
      try { await api(`/expenses/${expense.id}`, { method: 'DELETE' }); await loadExpenses(); notice('Expense deleted.'); }
      catch (error) { message('list-error', error.message); remove.disabled = false; }
    });
    row.append(icon, description, amount, remove); $('expense-list').append(row);
  }
  $('load-more').hidden = nextCursor === null;
}
async function loadExpenses(append = false) {
  message('list-error');
  const before = append && nextCursor !== null ? `&before=${nextCursor}` : '';
  const body = await api(`/expenses?limit=20${before}`);
  rows = append ? [...rows, ...body.items] : body.items;
  nextCursor = body.nextCursor;
  $('total-amount').textContent = money(body.summary.totalCents);
  $('total-count').textContent = String(body.summary.count);
  renderRows();
}
$('login-tab').addEventListener('click', () => setMode('login'));
$('signup-tab').addEventListener('click', () => setMode('signup'));
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault(); message('auth-error');
  const button = $('auth-submit'); button.disabled = true;
  $('login-tab').disabled = true; $('signup-tab').disabled = true;
  try {
    const result = await api(`/auth/${mode === 'login' ? 'login' : 'signup'}`, { method: 'POST', body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value }) });
    clearDashboard(); saveSession(result); $('password').value = ''; showView();
    try { await loadExpenses(); } catch (error) { message('list-error', error.message); }
  } catch (error) { message('auth-error', error.message); }
  finally { button.disabled = false; $('login-tab').disabled = false; $('signup-tab').disabled = false; }
});
$('expense-form').addEventListener('submit', async event => {
  event.preventDefault(); message('expense-error');
  const rawAmount = $('amount').value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(rawAmount)) return message('expense-error', 'Amount: enter dollars with up to two decimal places, such as 12.50.');
  const [dollars, cents = ''] = rawAmount.split('.');
  const amountCents = Number(dollars) * 100 + Number(cents.padEnd(2, '0'));
  const title = $('title').value.trim();
  if (!title) return message('expense-error', 'Description: enter what the expense was for.');
  if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 100000000) return message('expense-error', 'Amount: enter between $0.01 and $1,000,000.00.');
  const body = JSON.stringify({ title, amountCents });
  if (!pendingCreate || pendingCreate.body !== body) rememberPending({ body, key: crypto.randomUUID() });
  const pending = pendingCreate;
  const button = $('save-expense'); button.disabled = true; $('title').disabled = true; $('amount').disabled = true;
  try {
    await api('/expenses', { method: 'POST', headers: { 'Idempotency-Key': pending.key }, body: pending.body });
    rememberPending(null); $('expense-form').reset(); notice('Expense saved.');
    try { await loadExpenses(); } catch (error) { message('list-error', error.message); }
  } catch (error) { message('expense-error', error.message + (error.status ? '' : ' Try saving again; the same request will not be duplicated.')); }
  finally { button.disabled = false; $('title').disabled = false; $('amount').disabled = false; }
});
$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try { await api('/auth/logout', { method: 'POST' }); saveSession(null); clearDashboard(); showView(); notice('Signed out.'); }
  catch (error) { if (session) notice(error.message); }
  finally { $('logout').disabled = false; }
});
for (const [id, append] of [['refresh', false], ['load-more', true]]) $(id).addEventListener('click', async () => {
  $(id).disabled = true;
  try { await loadExpenses(append); } catch (error) { message('list-error', error.message); }
  finally { $(id).disabled = false; }
});
showView();
if (session && pendingCreate) {
  try {
    const value = JSON.parse(pendingCreate.body);
    $('title').value = value.title; $('amount').value = (value.amountCents / 100).toFixed(2);
    message('expense-error', 'An earlier save was not confirmed. Save again to safely check the same request.');
  } catch { rememberPending(null); }
}
if (session) loadExpenses().catch(error => message('list-error', error.message));
