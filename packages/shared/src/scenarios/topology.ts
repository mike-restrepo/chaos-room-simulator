import type { ServiceNodeDefinition } from '../contracts/index.js';

export const SHARED_SYSTEM_DESCRIPTION =
  'Fictional event-reservation platform where visitors reserve event spots via an API gateway and reservation service backed by an inventory database, while an asynchronous confirmation queue and worker dispatch ticket confirmations through an external notification provider. Reservations and confirmations are distinct states.';

export const SHARED_TOPOLOGY: ServiceNodeDefinition[] = [
  {
    id: 'visitor',
    name: 'Visitor',
    role: 'Submits event spot reservation requests and awaits ticket confirmations.',
    upstreamIds: [],
    downstreamIds: ['api-gateway'],
  },
  {
    id: 'api-gateway',
    name: 'API gateway',
    role: 'Routes incoming client traffic and enforces a 2,500 ms request timeout.',
    upstreamIds: ['visitor'],
    downstreamIds: ['reservation-service'],
  },
  {
    id: 'reservation-service',
    name: 'Reservation service',
    role: 'Acquires a pooled DB connection, persists the reservation, and enqueues a confirmation event.',
    upstreamIds: ['api-gateway'],
    downstreamIds: ['inventory-db', 'confirmation-queue'],
  },
  {
    id: 'inventory-db',
    name: 'Inventory database',
    role: 'Stores event inventory and reservation records with a bounded connection pool.',
    upstreamIds: ['reservation-service'],
    downstreamIds: [],
  },
  {
    id: 'confirmation-queue',
    name: 'Confirmation queue',
    role: 'Buffers accepted reservation events until ticket confirmation delivery completes.',
    upstreamIds: ['reservation-service'],
    downstreamIds: ['confirmation-worker'],
  },
  {
    id: 'confirmation-worker',
    name: 'Confirmation worker',
    role: 'Consumes queued reservation events and dispatches confirmation messages.',
    upstreamIds: ['confirmation-queue'],
    downstreamIds: ['notification-provider'],
  },
  {
    id: 'notification-provider',
    name: 'Notification provider',
    role: 'External email/SMS delivery service that sends the visitor their ticket confirmation.',
    upstreamIds: ['confirmation-worker'],
    downstreamIds: [],
  },
];
