import type { FFetchRequestInit } from '../types.js'
import type { ClientPlugin } from '../plugins.js'

type RequestShortcut = <
  TThis extends (
    input: RequestInfo | URL,
    init?: FFetchRequestInit
  ) => Promise<Response>,
>(
  this: TThis,
  input: RequestInfo | URL,
  init?: FFetchRequestInit
) => ReturnType<TThis>

export type RequestShortcuts = {
  get: RequestShortcut
  post: RequestShortcut
  put: RequestShortcut
  patch: RequestShortcut
  delete: RequestShortcut
  head: RequestShortcut
  options: RequestShortcut
}

function methodShortcut(method: RequestInit['method']): RequestShortcut {
  return function requestShortcut<
    TThis extends (
      input: RequestInfo | URL,
      init?: FFetchRequestInit
    ) => Promise<Response>,
  >(
    this: TThis,
    input: RequestInfo | URL,
    init: FFetchRequestInit = {}
  ): ReturnType<TThis> {
    if (typeof this !== 'function') {
      throw new TypeError(
        'requestShortcutsPlugin methods must be called from a client instance'
      )
    }

    const client = this as TThis

    return client(input, { ...init, method }) as ReturnType<TThis>
  }
}

export function requestShortcutsPlugin(): ClientPlugin<RequestShortcuts> {
  return {
    name: 'request-shortcuts',
    setup: ({ defineExtension }) => {
      defineExtension('get', {
        value: methodShortcut('GET'),
        enumerable: false,
      })
      defineExtension('post', {
        value: methodShortcut('POST'),
        enumerable: false,
      })
      defineExtension('put', {
        value: methodShortcut('PUT'),
        enumerable: false,
      })
      defineExtension('patch', {
        value: methodShortcut('PATCH'),
        enumerable: false,
      })
      defineExtension('delete', {
        value: methodShortcut('DELETE'),
        enumerable: false,
      })
      defineExtension('head', {
        value: methodShortcut('HEAD'),
        enumerable: false,
      })
      defineExtension('options', {
        value: methodShortcut('OPTIONS'),
        enumerable: false,
      })
    },
  }
}
