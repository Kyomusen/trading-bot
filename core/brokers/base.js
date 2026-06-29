class BaseBroker {
  constructor(config = {}) {
    this.config = config;
    this.isConnected = false;
  }

  async connect() {
    throw new Error('connect() must be implemented by subclass');
  }

  async disconnect() {
    throw new Error('disconnect() must be implemented by subclass');
  }

  async getCandles(_symbol, _timeframe, _limit = 100) {
    throw new Error('getCandles() must be implemented by subclass');
  }

  async placeOrder(_symbol, _type, _lotSize, _sl, _comment = '', _trailingOptions = null) {
    throw new Error('placeOrder() must be implemented by subclass');
  }

  async getOpenPositions(_symbol) {
    throw new Error('getOpenPositions() must be implemented by subclass');
  }

  async closePosition(_positionId) {
    throw new Error('closePosition() must be implemented by subclass');
  }

  async getAccountInfo() {
    throw new Error('getAccountInfo() must be implemented by subclass');
  }

  async getSymbolInfo(_symbol) {
    throw new Error('getSymbolInfo() must be implemented by subclass');
  }

  isReady() {
    return this.isConnected;
  }
}

module.exports = BaseBroker;
