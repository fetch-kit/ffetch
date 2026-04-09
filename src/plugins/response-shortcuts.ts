import type { ClientPlugin } from '../plugins.js'

export type ResponseShortcuts = {
  json: <T = unknown>() => Promise<T>
  text: () => Promise<string>
  blob: () => Promise<Blob>
  arrayBuffer: () => Promise<ArrayBuffer>
  formData: () => Promise<FormData>
}

type ResponseShortcutsPromise = Promise<Response> & ResponseShortcuts

type DecoratedPromise = ResponseShortcutsPromise & {
  __ffetchResponseShortcutsDecorated__?: true
}

function attachResponseShortcuts(
  promise: Promise<Response>
): ResponseShortcutsPromise {
  const decorated = promise as DecoratedPromise

  if (decorated.__ffetchResponseShortcutsDecorated__) {
    return decorated
  }

  Object.defineProperties(decorated, {
    json: {
      value: function json<T = unknown>(this: Promise<Response>) {
        return this.then((response) => response.json() as Promise<T>)
      },
      writable: false,
      enumerable: false,
      configurable: false,
    },
    text: {
      value: function text(this: Promise<Response>) {
        return this.then((response) => response.text())
      },
      writable: false,
      enumerable: false,
      configurable: false,
    },
    blob: {
      value: function blob(this: Promise<Response>) {
        return this.then((response) => response.blob())
      },
      writable: false,
      enumerable: false,
      configurable: false,
    },
    arrayBuffer: {
      value: function arrayBuffer(this: Promise<Response>) {
        return this.then((response) => response.arrayBuffer())
      },
      writable: false,
      enumerable: false,
      configurable: false,
    },
    formData: {
      value: function formData(this: Promise<Response>) {
        return this.then((response) => response.formData())
      },
      writable: false,
      enumerable: false,
      configurable: false,
    },
    __ffetchResponseShortcutsDecorated__: {
      value: true,
      writable: false,
      enumerable: false,
      configurable: false,
    },
  })

  return decorated
}

export function responseShortcutsPlugin(): ClientPlugin<
  Record<never, never>,
  ResponseShortcuts
> {
  return {
    name: 'response-shortcuts',
    decoratePromise: (promise) => attachResponseShortcuts(promise),
  }
}
