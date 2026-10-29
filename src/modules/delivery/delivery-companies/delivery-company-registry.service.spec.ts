import { DeliveryCompanyRegistry } from './delivery-company-registry.service';

function handler(companyId: string, capabilities: Record<string, unknown> = {}) {
  return {
    companyId,
    createOrder: jest.fn(),
    ...capabilities,
  } as any;
}

describe('DeliveryCompanyRegistry', () => {
  it('registers every injected handler by its company id', () => {
    const registry = new DeliveryCompanyRegistry([
      handler('noest'),
      handler('acme'),
    ]);

    expect(registry.getHandler('noest')?.companyId).toBe('noest');
    expect(registry.getHandler('acme')?.companyId).toBe('acme');
    expect(registry.getHandler('missing')).toBeNull();
    expect(registry.getRegisteredCompanyIds()).toEqual(['noest', 'acme']);
  });

  it('reports only handlers that can produce labels', () => {
    const registry = new DeliveryCompanyRegistry([
      handler('noest'),
      handler('zeta', { createLabels: jest.fn() }),
      handler('alpha', { createLabels: jest.fn() }),
    ]);

    expect(registry.getLabelCapableCompanyIds()).toEqual(['alpha', 'zeta']);
  });
});
