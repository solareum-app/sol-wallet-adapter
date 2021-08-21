import EventEmitter from 'eventemitter3';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

export default class Wallet extends EventEmitter {
  constructor(provider, network) {
    super();
    if (isInjectedProvider(provider)) {
      this._injectedProvider = provider;
    } else if (isString(provider)) {
      this._providerUrl = new URL(provider);
      this._providerUrl.hash = new URLSearchParams({
        origin: window.location.origin,
        network,
      }).toString();
    } else {
      throw new Error(
        'provider parameter must be an injected provider or a URL string.',
      );
    }
    this._network = network;
    this._publicKey = null;
    this._autoApprove = false;
    this._popup = null;
    this._handlerAdded = false;
    this._nextRequestId = 1;
    this._responsePromises = new Map();
  }

  _handleMessage = (e) => {
    // support react native, it only receive string as data
    // isRN will be sent embeded from the postMessage
    let data = e.data;
    if (typeof e.data === 'string') {
      try {
        data = JSON.parse(e.data);
      } catch {}
    }

    if (
      (typeof data === 'object' && data.isRN) ||
      (this._injectedProvider && e.source === window) ||
      (e.origin === this._providerUrl.origin && e.source === this._popup)
    ) {
      if (data.method === 'connected') {
        const newPublicKey = new PublicKey(data.params.publicKey);
        if (!this._publicKey || !this._publicKey.equals(newPublicKey)) {
          if (this._publicKey && !this._publicKey.equals(newPublicKey)) {
            this._handleDisconnect();
          }
          this._publicKey = newPublicKey;
          this._autoApprove = !!data.params.autoApprove;
          this.emit('connect', this._publicKey);
        }
      } else if (data.method === 'disconnected') {
        this._handleDisconnect();
      } else if (data.result || data.error) {
        if (this._responsePromises.has(data.id)) {
          const [resolve, reject] = this._responsePromises.get(data.id);
          if (data.result) {
            resolve(data.result);
          } else {
            reject(new Error(data.error));
          }
        }
      }
    }
  };

  _handleConnect = () => {
    if (!this._handlerAdded) {
      this._handlerAdded = true;
      const isUIWebView = /\(ip.*applewebkit(?!.*(version|crios))/i.test(
        navigator.userAgent,
      );
      const receiver = isUIWebView ? window : document;
      receiver.addEventListener('message', this._handleMessage);
      receiver.addEventListener('beforeunload', this.disconnect);
    }
    if (this._injectedProvider) {
      return new Promise((resolve) => {
        this._sendRequest('connect', {});
        resolve();
      });
    } else {
      window.name = 'parent';
      this._popup = window.open(
        this._providerUrl.toString(),
        '_blank',
        'location,resizable,width=460,height=675',
      );
      return new Promise((resolve) => {
        this.once('connect', resolve);
      });
    }
  };

  _handleDisconnect = () => {
    if (this._handlerAdded) {
      this._handlerAdded = false;
      window.removeEventListener('message', this._handleMessage);
      window.removeEventListener('beforeunload', this.disconnect);
    }
    if (this._publicKey) {
      this._publicKey = null;
      this.emit('disconnect');
    }
    this._responsePromises.forEach(([resolve, reject], id) => {
      this._responsePromises.delete(id);
      reject('Wallet disconnected');
    });
  };

  _sendRequest = async (method, params) => {
    if (method !== 'connect' && !this.connected) {
      throw new Error('Wallet not connected');
    }
    const requestId = this._nextRequestId;
    ++this._nextRequestId;
    return new Promise((resolve, reject) => {
      this._responsePromises.set(requestId, [resolve, reject]);
      if (this._injectedProvider) {
        this._injectedProvider.postMessage({
          jsonrpc: '2.0',
          id: requestId,
          method,
          params: {
            network: this._network,
            ...params,
          },
        });
      } else {
        this._popup.postMessage(
          {
            jsonrpc: '2.0',
            id: requestId,
            method,
            params,
          },
          this._providerUrl.origin,
        );

        if (!this.autoApprove) {
          this._popup.focus();
        }
      }
    });
  };

  get publicKey() {
    return this._publicKey;
  }

  get connected() {
    return this._publicKey !== null;
  }

  get autoApprove() {
    return this._autoApprove;
  }

  connect = () => {
    if (this._popup) {
      this._popup.close();
    }
    return this._handleConnect();
  };

  disconnect = async () => {
    if (this._injectedProvider) {
      await this._sendRequest('disconnect', {});
    }
    if (this._popup) {
      this._popup.close();
    }
    this._handleDisconnect();
  };

  sign = async (data, display) => {
    if (!(data instanceof Uint8Array)) {
      throw new Error('Data must be an instance of Uint8Array');
    }

    const response = await this._sendRequest('sign', {
      data,
      display,
    });
    const signature = bs58.decode(response.signature);
    const publicKey = new PublicKey(response.publicKey);
    return {
      signature,
      publicKey,
    };
  };

  signTransaction = async (transaction) => {
    const response = await this._sendRequest('signTransaction', {
      message: bs58.encode(transaction.serializeMessage()),
    });
    const signature = bs58.decode(response.signature);
    const publicKey = new PublicKey(response.publicKey);
    transaction.addSignature(publicKey, signature);
    return transaction;
  };

  signAllTransactions = async (transactions) => {
    const response = await this._sendRequest('signAllTransactions', {
      messages: transactions.map((tx) => bs58.encode(tx.serializeMessage())),
    });
    const signatures = response.signatures.map((s) => bs58.decode(s));
    const publicKey = new PublicKey(response.publicKey);
    transactions = transactions.map((tx, idx) => {
      tx.addSignature(publicKey, signatures[idx]);
      return tx;
    });
    return transactions;
  };
}

function isString(a) {
  return typeof a === 'string';
}

function isInjectedProvider(a) {
  return isObject(a) && isFunction(a.postMessage);
}

function isObject(a) {
  return typeof a === 'object' && a !== null;
}

function isFunction(a) {
  return typeof a === 'function';
}
