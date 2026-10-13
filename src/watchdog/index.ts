// What other modules report into: raiseIncident(kind, key, detail, fix) when something is wrong, and
// resolveIncident(kind, key) when it is fine again. The watchdog posts each one and the Health page lists it.
export { raiseIncident, resolveIncident, readIncidents, healthStatus, KINDS, type Incident, type HealthStatus, type Severity, type RaiseOptions } from './incidents.js';
