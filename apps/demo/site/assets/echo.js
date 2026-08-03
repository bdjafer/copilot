/**
 * The echo responder — the entire "copilot" of this demo, with no model, no network and no
 * extension. It is SPEC-comment-core §7.1's seven-line quick start, hardened into the four
 * rules a real host also has to honour, and nothing more.
 *
 *   1. `comment.author !== 'user'` returns. The author field is the ONLY trigger-loop guard
 *      (SPEC-comment-core §7.3) — without it the responder echoes its own echo forever.
 *   2. Replies are written with a deterministic `id` derived from the comment they answer.
 *      `appendComment` is idempotent on `input.id` (§4.1 rule 15), so a reload mid-flight, a
 *      second tab observing the same store, or a double-fire cannot double-post.
 *   3. The thread is re-read from the store before writing. A thread deleted while the
 *      responder was "thinking" must drop its output, not resurrect the thread.
 *   4. `author: 'copilot'` never reopens a resolved thread (`defaultReopensOnReply`), while a
 *      user reply does. `AppendResult.reopened` is reported back so the page can show it.
 *
 * Pure by construction: it takes a `CommentEngine` (or any `CommentDomain` with `on()`) and
 * touches no globals, which is why the vitest integration test can drive the very same file.
 */

/** Canned replies, keyed by the mode a thread was created in. */
export function echoReply(kind, body) {
  if (kind === 'ask') {
    return `You asked: “${body}”. There is no model here — the echo responder answers everything.`
  }
  return `echo: ${body}`
}

/**
 * @param engine  a comment-core engine (or headless domain) with `on` + `get` + `appendComment`
 * @param options { delay, reply, onBusy, onReplied, onError }
 * @returns detach() — removes the listeners and cancels every scheduled reply
 */
export function attachEchoResponder(engine, options = {}) {
  const delay = options.delay ?? 800
  const reply = options.reply ?? echoReply
  const onBusy = options.onBusy ?? noop
  const onReplied = options.onReplied ?? noop
  const onError = options.onError ?? noop

  /** threadId -> timer. One pending reply per thread; a newer comment supersedes the older. */
  const pending = new Map()

  function cancel(threadId) {
    const timer = pending.get(threadId)
    if (timer === undefined) return
    clearTimeout(timer)
    pending.delete(threadId)
    onBusy(threadId, false)
  }

  function schedule(thread, comment) {
    if (comment.author !== 'user') return // rule 1 — the loop guard
    cancel(thread.id)
    onBusy(thread.id, true)
    pending.set(
      thread.id,
      setTimeout(() => {
        pending.delete(thread.id)
        void respond(thread, comment)
      }, delay),
    )
  }

  async function respond(thread, comment) {
    try {
      // rule 3 — durable check, not a view read: the tab may have been reloaded since.
      if (!(await engine.get(thread.id))) return
      const result = await engine.appendComment(thread.id, {
        author: 'copilot',
        body: reply(thread.kind, comment.body),
        id: `echo:${comment.id}`, // rule 2 — idempotency key
      })
      onReplied(thread.id, result) // rule 4 — result.reopened is always false for 'copilot'
    } catch (error) {
      onError(error)
    } finally {
      onBusy(thread.id, false)
    }
  }

  const off = [
    engine.on('thread:create', ({ thread, comment }) => schedule(thread, comment)),
    engine.on('thread:reply', ({ thread, comment }) => schedule(thread, comment)),
    engine.on('thread:delete', ({ thread }) => cancel(thread.id)),
  ]

  return function detach() {
    for (const threadId of [...pending.keys()]) cancel(threadId)
    for (const unsubscribe of off.splice(0)) unsubscribe()
  }
}

function noop() {}
