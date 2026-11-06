// Marks expected user conditions rather than platform failures, so they are
// shown to the user without being reported to Sentry.
export class ExpectedUserError extends Error {}
