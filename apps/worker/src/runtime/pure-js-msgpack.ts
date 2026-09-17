// Must be imported before anything that loads BullMQ.
// Owner decision: msgpackr runs in pure-JavaScript mode (its native install script is blocked and
// its prebuilt native acceleration is disabled through msgpackr's documented switch).
process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED = 'true';

export {};
