// FakeCloud adversary for engine integration tests (spec 13.2): one
// "server" copy plus one mirror folder per device; a device's engine only ever sees its mirror.
// The implementation lives with the scenario harness (integration/fake-cloud.ts); this module
// is its stable import path for other engine tests.
export * from './integration/fake-cloud.js';
