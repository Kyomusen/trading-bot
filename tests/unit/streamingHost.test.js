// tests/unit/streamingHost.test.js
// Unit test: CapitalClient must capture streamingHost from session response,
// and CapitalStream must use broker.streamingHost (not a string-derived host).
//
// Run: node tests/unit/streamingHost.test.js
// (no test framework — plain assert, matches repo convention)

const assert = require('assert');
const path = require('path');
const Module = require('module');

// --- Mock axios BEFORE requiring capitalClient (which requires axios) ---
const MOCK_STREAMING_HOST = 'wss://api-streaming-capital.backend-capital.com/';
const MOCK_SESSION = {
  status: 200,
  headers: { cst: 'MOCK_CST', 'x-security-token': 'MOCK_SEC' },
  data: {
    accountId: 'MOCK_ACC',
    streamingHost: MOCK_STREAMING_HOST,
  },
};

const axiosMock = {
  post: async (url) => {
    assert.strictEqual(url.endsWith('/api/v1/session'), true, 'axios.post called on session endpoint');
    return MOCK_SESSION;
  },
  get: async () => ({ data: {} }),
};

const axiosPath = require.resolve('axios');
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: axiosMock };

// Force config to use demo env without a real .env
process.env.CAPITAL_ENV = 'demo';
process.env.CAPITAL_API_KEY = 'k';
process.env.CAPITAL_IDENTIFIER = 'i';
process.env.CAPITAL_PASSWORD = 'p';

const broker = require('../../broker/capitalClient');
const { CapitalStream } = require('../../broker/capitalStream');

(async () => {
  // 1. CapitalClient captures streamingHost from session response
  // (capitalClient exports a singleton instance, matching production usage)
  assert.strictEqual(broker.streamingHost, null, 'streamingHost starts null before session');
  await broker.ensureSession();
  assert.strictEqual(
    broker.streamingHost,
    MOCK_STREAMING_HOST,
    `streamingHost should match mocked session value (got: ${broker.streamingHost})`
  );
  console.log('PASS 1: CapitalClient.streamingHost captured from session response =', broker.streamingHost);

  // 2. CapitalStream uses broker.streamingHost (constructor reads it)
  const stream = new CapitalStream({ epic: 'XAUUSD', brokerEpic: 'CS.D.XAUUSD.MINI' });
  assert.strictEqual(
    stream.host,
    MOCK_STREAMING_HOST,
    `CapitalStream.host should read broker.streamingHost (got: ${stream.host})`
  );
  console.log('PASS 2: CapitalStream.host reads broker.streamingHost =', stream.host);

  // 3. OLD derive function must be gone (no export named streamingHost)
  const mod = require('../../broker/capitalStream');
  assert.strictEqual(
    mod.streamingHost,
    undefined,
    'streamingHost should no longer be exported from capitalStream'
  );
  console.log('PASS 3: old streamingHost() derive function removed (not exported)');

  console.log('\nALL TESTS PASSED');
})().catch((e) => {
  console.error('TEST FAILED:', e.message);
  process.exit(1);
});
