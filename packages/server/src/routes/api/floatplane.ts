import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  pollFloatplaneDeviceAuthorization,
  requestFloatplaneDeviceAuthorization,
  storeFloatplaneAuth,
  type FloatplaneDeviceAuthorization,
} from '@aiostreams/core';

const router: Router = Router();
const states = new Map<
  string,
  {
    device: FloatplaneDeviceAuthorization;
    expiresAt: number;
    nextPollAt: number;
    polling?: boolean;
    authRef?: string;
    error?: string;
  }
>();
function cleanup() {
  const now = Date.now();
  for (const [key, state] of states)
    if (state.expiresAt <= now) states.delete(key);
}

router.get('/link/start', (_req, res) => {
  res.type('html')
    .send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link Floatplane</title><style>body{font:16px system-ui;background:#101116;color:#fff;max-width:680px;margin:7vh auto;padding:24px}button{font:inherit;padding:12px 18px;border:0;border-radius:8px;background:#8b5cf6;color:#fff}code{display:block;white-space:pre-wrap;word-break:break-all;background:#1d1e27;padding:12px;border-radius:8px;margin-top:12px}a{color:#c4b5fd}</style><h1>Link Floatplane</h1><p>Start the official Floatplane device link, then open the verification URL on any browser. AIOStreams keeps the account material encrypted server-side.</p><button id="start">Start device link</button><p id="status"></p><div id="details"></div><script>
const status=document.querySelector('#status'),details=document.querySelector('#details'),esc=s=>String(s??'').replace(/[&<>\'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
	document.querySelector('#start').onclick=async()=>{document.querySelector('#start').disabled=true;const r=await fetch('./device',{method:'POST'});const d=await r.json();if(!r.ok){status.textContent=d.error||'Unable to start link';return;}status.textContent='Enter the displayed code, then wait for confirmation.';details.innerHTML='<p>Code: <b>'+esc(d.userCode)+'</b></p><p><a target="_blank" rel="noreferrer" href="'+esc(d.verificationUri)+'">Open Floatplane verification</a></p><code id="result">Waiting for authorization…</code>';const poll=async()=>{const x=await (await fetch('./status/'+d.state)).json();if(x.status==='authorized'){document.querySelector('#result').textContent='Linked. Return to the AIOStreams Services page; no token needs to be copied.';status.textContent='Floatplane linked.';return;}if(x.status==='error'){status.textContent=x.error||'Authorization failed';return;}setTimeout(poll,(x.retryAfter||5)*1000)};poll()};
</script>`);
});
router.post('/link/device', async (_req, res) => {
  cleanup();
  try {
    const device = await requestFloatplaneDeviceAuthorization();
    const state = randomUUID();
    states.set(state, {
      device,
      expiresAt: Date.now() + device.expiresIn * 1000,
      nextPollAt: 0,
    });
    res.json({
      state,
      userCode: device.userCode,
      verificationUri: device.verificationUriComplete || device.verificationUri,
      expiresIn: device.expiresIn,
      expiresAt: Date.now() + device.expiresIn * 1000,
      interval: device.interval,
    });
  } catch (error) {
    res
      .status(502)
      .json({
        error:
          error instanceof Error
            ? error.message
            : 'Unable to start Floatplane link',
      });
  }
});
router.get('/link/status/:state', async (req, res) => {
  cleanup();
  const state = states.get(req.params.state);
  if (!state) {
    res
      .status(404)
      .json({ status: 'error', error: 'Link expired. Start again.' });
    return;
  }
  if (state.authRef) {
    res.json({ status: 'authorized', authRef: state.authRef });
    return;
  }
  if (state.error) {
    res.status(502).json({ status: 'error', error: state.error });
    return;
  }
  if (Date.now() < state.nextPollAt) {
    res.json({
      status: 'pending',
      retryAfter: Math.ceil((state.nextPollAt - Date.now()) / 1000),
    });
    return;
  }
  if (state.polling) {
    res.json({ status: 'pending', retryAfter: state.device.interval });
    return;
  }
  state.polling = true;
  try {
    const result = await pollFloatplaneDeviceAuthorization(state.device);
    if (result.status === 'pending') {
      state.nextPollAt = Date.now() + result.retryAfter * 1000;
      res.json({ status: 'pending', retryAfter: result.retryAfter });
      return;
    }
    state.authRef = await storeFloatplaneAuth(result.auth);
    state.expiresAt = Date.now() + 10 * 60 * 1000;
    res.json({ status: 'authorized', authRef: state.authRef });
  } catch (error) {
    state.error =
      error instanceof Error
        ? error.message
        : 'Floatplane authorization failed';
    res.status(502).json({ status: 'error', error: state.error });
  } finally {
    state.polling = false;
  }
});
export default router;
