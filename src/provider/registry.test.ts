import { describe, expect, it } from 'vitest';
import { ProviderRegistry, capabilitiesOf } from './registry.js';
import { ProviderId, type GenerationRequest } from './types.js';
import { makeFakeProvider } from './__fixtures__/fakeProvider.js';

describe('ProviderRegistry', () => {
  it('an empty registry yields no descriptors — the data the front door reads as "no generation UI"', () => {
    const registry = new ProviderRegistry();
    expect(registry.size).toBe(0);
    expect(registry.list()).toEqual([]);
    expect(registry.has(ProviderId('absent'))).toBe(false);
  });

  it('resolves a selection carried as a value to the registered provider', () => {
    const registry = new ProviderRegistry();
    const provider = makeFakeProvider({ id: 'tmux', label: 'Local tmux', outcome: 'success' });
    registry.register(provider);

    const request: GenerationRequest = {
      providerId: ProviderId('tmux'),
      brief: { description: 'a color picker' },
    };

    expect(registry.get(request.providerId)).toBe(provider);
    expect(registry.has(request.providerId)).toBe(true);
    expect(registry.size).toBe(1);
  });

  it('rejects a duplicate id loudly rather than silently overwriting', () => {
    const registry = new ProviderRegistry();
    registry.register(makeFakeProvider({ id: 'tmux', label: 'A', outcome: 'success' }));
    expect(() => registry.register(makeFakeProvider({ id: 'tmux', label: 'B', outcome: 'success' }))).toThrow(
      /already registered/,
    );
  });

  it('fails loudly on selection of an unknown provider — no null to guard', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.get(ProviderId('nope'))).toThrow(/unknown provider/);
  });

  it('derives capabilities from method presence, not a hand-set flag', () => {
    const registry = new ProviderRegistry();
    registry.register(makeFakeProvider({ id: 'one-shot', label: 'One-shot', outcome: 'success' }));
    registry.register(
      makeFakeProvider({ id: 'iterable', label: 'Iterable', outcome: 'success', iterable: true }),
    );

    const byId = new Map(registry.list().map((d) => [d.id, d.capabilities]));
    expect(byId.get(ProviderId('one-shot'))).toEqual({ continue: false, fork: false });
    expect(byId.get(ProviderId('iterable'))).toEqual({ continue: true, fork: true });
  });

  it('capabilitiesOf reads the provider directly', () => {
    expect(capabilitiesOf(makeFakeProvider({ id: 'x', label: 'x', outcome: 'success' }))).toEqual({
      continue: false,
      fork: false,
    });
  });

  it('availabilityOf delegates to the live provider and surfaces the reason when down', async () => {
    const registry = new ProviderRegistry();
    registry.register(
      makeFakeProvider({
        id: 'down',
        label: 'Down',
        outcome: 'success',
        availability: { state: 'unavailable', reason: 'tmux not running' },
      }),
    );
    await expect(registry.availabilityOf(ProviderId('down'))).resolves.toEqual({
      state: 'unavailable',
      reason: 'tmux not running',
    });
  });
});
