import { MockDetentionSubmitter, type DetentionSubmitter } from './detention-submission.js';
import { MockPayments, type PaymentsProvider } from './payments.js';

// Every external system sits behind an interface. Only mocks exist; nothing real is called.
// Mileage and fuel card data come from seed rows (`loads.loaded_miles`, `payment_method`).

export interface Integrations {
  payments: PaymentsProvider;
  detentionSubmitter: DetentionSubmitter;
}

export type IntegrationsMode = 'mock';

export function createIntegrations(mode: IntegrationsMode): Integrations {
  switch (mode) {
    case 'mock':
      return { payments: new MockPayments(), detentionSubmitter: new MockDetentionSubmitter() };
  }
}
