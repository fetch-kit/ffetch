import type { ClientPlugin } from '../plugins.js'
import { CircuitOpenError } from '../error.js'

export type CircuitPluginExtension = {
  circuitOpen: boolean
}

export type CircuitPluginOptions = {
  threshold: number
  reset: number
  onCircuitOpen?: (req: Request) => void | Promise<void>
  onCircuitClose?: (req: Request) => void | Promise<void>
  order?: number
}

export function circuitPlugin(
  options: CircuitPluginOptions
): ClientPlugin<CircuitPluginExtension> {
  const {
    threshold,
    reset,
    onCircuitOpen,
    onCircuitClose,
    order = 20,
  } = options

  let failures = 0
  let nextAttempt = 0
  let isOpen = false

  const shouldCountFailure = (
    response?: Response,
    error?: unknown
  ): boolean => {
    if (error) {
      return true
    }
    if (response && (response.status >= 500 || response.status === 429)) {
      return true
    }
    return false
  }

  const onSuccess = async (req: Request) => {
    const wasOpen = isOpen
    failures = 0
    if (wasOpen) {
      isOpen = false
      await onCircuitClose?.(req)
    }
  }

  const onFailure = async (req: Request): Promise<boolean> => {
    failures++
    if (failures >= threshold) {
      nextAttempt = Date.now() + reset
      isOpen = true
      await onCircuitOpen?.(req)
      return true
    }
    return false
  }

  return {
    name: 'circuit',
    order,
    setup: ({ defineExtension }) => {
      defineExtension('circuitOpen', {
        get: () => isOpen,
        enumerable: true,
      })
    },
    preRequest: async (ctx) => {
      if (Date.now() < nextAttempt) {
        await onCircuitOpen?.(ctx.request)
        throw new CircuitOpenError('Circuit is open')
      }
    },
    onSuccess: async (ctx, response) => {
      if (shouldCountFailure(response, undefined)) {
        const opened = await onFailure(ctx.request)
        if (opened) {
          throw new CircuitOpenError('Circuit is open')
        }
      } else {
        await onSuccess(ctx.request)
      }
    },
    onError: async (ctx, error) => {
      if (error instanceof CircuitOpenError) {
        return
      }
      if (shouldCountFailure(undefined, error)) {
        const opened = await onFailure(ctx.request)
        if (opened) {
          throw new CircuitOpenError('Circuit is open')
        }
      }
    },
  }
}
