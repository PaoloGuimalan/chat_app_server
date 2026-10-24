// Serializing authorization and delivery preserves event order and rechecks
// membership for every frame, including streams opened before a member left.
const authorizedPostStream = (response, authorize, disconnect) => {
  let closed = false;
  let pending = Promise.resolve();

  const close = async () => {
    if (closed) return;
    closed = true;
    await disconnect();
  };

  return {
    close,
    sse(event, payload) {
      pending = pending.then(async () => {
        if (closed) return;
        try {
          if (!(await authorize())) {
            await close();
            return;
          }
          response.sse(event, payload);
        } catch {
          await close();
        }
      });
      return pending;
    },
  };
};

module.exports = { authorizedPostStream };
