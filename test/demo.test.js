import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const DEMO_HTML = fileURLToPath(new URL('../demo/index.html', import.meta.url));

class Element {
  constructor({ id = '', className = '', dataset = {}, parent = null } = {}) {
    this.id = id;
    this.className = className;
    this.dataset = dataset;
    this.parent = parent;
    this.textContent = '';
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  closest(selector) {
    if (selector === '.add-to-cart' && this.className.split(/\s+/).includes('add-to-cart')) return this;
    return null;
  }

  click() {
    const event = { target: this, preventDefault() {} };
    this.#dispatch('click', event);
  }

  #dispatch(type, event) {
    for (const handler of this.listeners.get(type) || []) handler.call(this, event);
    if (this.parent) this.parent.#dispatch(type, event);
  }
}

test('demo add-to-cart increments once per click', () => {
  const html = readFileSync(DEMO_HTML, 'utf8');
  const match = html.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/);
  assert.ok(match, 'expected inline demo script');

  const grid = new Element({ className: 'grid' });
  const buttons = [
    new Element({ className: 'secondary add-to-cart', dataset: { sku: 'eth-yirg' }, parent: grid }),
    new Element({ className: 'secondary add-to-cart', dataset: { sku: 'col-huila' }, parent: grid }),
  ];
  const ids = {
    'cart-count': new Element({ id: 'cart-count' }),
    'shop-now': new Element({ id: 'shop-now' }),
    'subscribe-form': new Element({ id: 'subscribe-form' }),
    'subscribe-status': new Element({ id: 'subscribe-status' }),
    'dev-throw': new Element({ id: 'dev-throw' }),
    'dev-reject': new Element({ id: 'dev-reject' }),
    'dev-fetch404': new Element({ id: 'dev-fetch404' }),
    'dev-fetchfail': new Element({ id: 'dev-fetchfail' }),
    'dev-warn': new Element({ id: 'dev-warn' }),
    'dev-open': new Element({ id: 'dev-open' }),
  };
  const contextCalls = [];

  vm.runInNewContext(match[1], {
    Requestor: {
      identify() {},
      setContext(value) { contextCalls.push(value); },
      open() {},
    },
    document: {
      querySelectorAll(selector) {
        return selector === '.add-to-cart' ? buttons : [];
      },
      querySelector(selector) {
        return selector === '.grid' ? grid : null;
      },
      getElementById(id) {
        return ids[id];
      },
    },
    location: { hash: '' },
    fetch() { return Promise.resolve({ ok: true, status: 200 }); },
    console: { log() {}, warn() {} },
    Promise,
  });

  buttons[0].click();
  assert.equal(ids['cart-count'].textContent, 1);
  assert.equal(contextCalls.at(-1).cartItems, 1);

  buttons[1].click();
  assert.equal(ids['cart-count'].textContent, 2);
  assert.equal(contextCalls.at(-1).cartItems, 2);
});
