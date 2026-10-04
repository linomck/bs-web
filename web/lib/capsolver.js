/**
 * N2nd - CapSolver Client
 * Löst reCAPTCHA v2 Challenges auf der Burning-Series-Episodenseite via
 * ReCaptchaV2TaskProxyLess (siehe AGENTS.md, CapSolver-Integration aus background.js portiert).
 */

const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY || '';
const CREATE_TASK_URL = 'https://api.capsolver.com/createTask';
const GET_RESULT_URL = 'https://api.capsolver.com/getTaskResult';

const MAX_POLLS = 30;
const POLL_INTERVAL_MS = 2500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConfigured() {
  return Boolean(CAPSOLVER_API_KEY);
}

/**
 * Löst eine reCAPTCHA-v2-Challenge und liefert das g-recaptcha-response Ticket.
 */
async function solveRecaptchaV2(websiteURL, websiteKey) {
  if (!CAPSOLVER_API_KEY) {
    throw new Error('CAPSOLVER_API_KEY ist nicht gesetzt (siehe web/.env.example).');
  }
  if (!websiteURL || !websiteKey) {
    throw new Error('websiteURL und websiteKey sind für CapSolver erforderlich.');
  }

  const createResp = await fetch(CREATE_TASK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: CAPSOLVER_API_KEY,
      task: {
        type: 'ReCaptchaV2TaskProxyLess',
        websiteURL,
        websiteKey,
      },
    }),
  });
  const createData = await createResp.json();

  if (createData.errorId && createData.errorId !== 0) {
    throw new Error(`CapSolver createTask Fehler: ${createData.errorDescription || createData.errorCode}`);
  }
  if (!createData.taskId) {
    throw new Error('CapSolver hat keine taskId zurückgegeben.');
  }

  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);

    const pollResp = await fetch(GET_RESULT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: CAPSOLVER_API_KEY, taskId: createData.taskId }),
    });
    const pollData = await pollResp.json();

    if (pollData.errorId && pollData.errorId !== 0) {
      throw new Error(`CapSolver getTaskResult Fehler: ${pollData.errorDescription || pollData.errorCode}`);
    }

    if (pollData.status === 'ready') {
      const ticket = pollData.solution && pollData.solution.gRecaptchaResponse;
      if (!ticket) throw new Error('CapSolver lieferte kein gRecaptchaResponse-Ticket.');
      return ticket;
    }
  }

  throw new Error('CapSolver Timeout: Captcha wurde nicht rechtzeitig gelöst.');
}

module.exports = {
  isConfigured,
  solveRecaptchaV2,
};
