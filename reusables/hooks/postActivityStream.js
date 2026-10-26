// Serializing authorization and delivery preserves event order and rechecks
// membership for every frame, including streams opened before a member left.
const authorizedPostStream = (response, authorize, disconnect, viewerEntityID) => {
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
          // The sender is Redis-only routing metadata. Anonymous peers must
          // never receive it, and the author must not see their own typing.
          const { _sender_entity_id: sender, ...publicPayload } = payload;
          const activity = publicPayload.result;
          const actor = sender ?? activity?.entity?.entity_id;
          if (activity?.event_type === "typing" && viewerEntityID && actor &&
              String(actor) === String(viewerEntityID)) return;
          response.sse(event, publicPayload);
        } catch {
          await close();
        }
      });
      return pending;
    },
  };
};

module.exports = { authorizedPostStream };
