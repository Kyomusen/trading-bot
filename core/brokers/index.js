const CapitalBroker = require('./capital');
const OandaBroker = require('./oanda');

const brokers = {
  capital: CapitalBroker,
  oanda: OandaBroker,
};

function createBroker(type, config) {
  const BrokerClass = brokers[type];
  if (!BrokerClass) {
    throw new Error(`Unknown broker type: ${type}. Available: ${Object.keys(brokers).join(', ')}`);
  }
  return new BrokerClass(config);
}

module.exports = { createBroker, CapitalBroker, OandaBroker };
