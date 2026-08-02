export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  main() {
    // comment-core + comment-ui instantiation. Lands in M3 (see PLAN.md §5).
  },
})
