/**
 * Vendored from Hypothesis `annotator/anchoring/text-range.ts` (BSD-2, see ./LICENSE).
 *
 * The TextPosition half of the chain: convert between a DOM `Range` and a pair of character
 * offsets into a root node's text content, so a quote located by `matchQuote` in a flat string
 * can be turned back into a live selection.
 *
 * Ported to this codebase's module/type conventions rather than copied byte-for-byte (no
 * network access at implementation time); the traversal semantics — text nodes in document
 * order, offsets over concatenated `data`, a position resolving to the node that *contains*
 * it — are Hypothesis's.
 */

import { isTextNode, textNodesOf } from '../../dom.ts'

export interface TextOffsets {
  /** The concatenated text of every text node under the root, in document order. */
  text: string
  nodes: Array<{ node: Text; start: number; end: number }>
}

/** Flatten a subtree's text nodes into one string plus an offset index. */
export function textOffsets(root: Node): TextOffsets {
  const nodes: TextOffsets['nodes'] = []
  let text = ''
  for (const node of textNodesOf(root)) {
    const start = text.length
    text += node.data
    nodes.push({ node, start, end: text.length })
  }
  return { text, nodes }
}

/** Character offsets of `range` within `root`'s flattened text, or null when it is outside. */
export function rangeToTextPosition(
  root: Node,
  range: Range,
): { start: number; end: number } | null {
  const { nodes } = textOffsets(root)
  const locate = (container: Node, offset: number, isEnd: boolean): number | null => {
    if (isTextNode(container)) {
      const entry = nodes.find((candidate) => candidate.node === container)
      return entry ? entry.start + Math.min(offset, container.data.length) : null
    }
    // An element container addresses its child *nodes*: map to the boundary between them.
    const children = Array.from(container.childNodes)
    const boundary = children[Math.min(offset, Math.max(0, children.length - 1))]
    if (!boundary) return isEnd ? textLengthOf(nodes) : 0
    const covered = nodes.filter(
      (candidate) => boundary.contains?.(candidate.node) ?? candidate.node === boundary,
    )
    if (covered.length === 0) return null
    return offset >= children.length || isEnd ? covered[covered.length - 1]!.end : covered[0]!.start
  }

  const start = locate(range.startContainer, range.startOffset, false)
  const end = locate(range.endContainer, range.endOffset, true)
  if (start === null || end === null) return null
  return { start: Math.min(start, end), end: Math.max(start, end) }
}

function textLengthOf(nodes: TextOffsets['nodes']): number {
  return nodes.length === 0 ? 0 : nodes[nodes.length - 1]!.end
}

/** Build a live `Range` from character offsets into `root`'s flattened text. */
export function textPositionToRange(root: Node, start: number, end: number): Range | null {
  const doc = root.ownerDocument ?? (root as Document)
  if (typeof doc?.createRange !== 'function') return null
  const { nodes } = textOffsets(root)
  if (nodes.length === 0) return null

  const total = textLengthOf(nodes)
  const from = Math.max(0, Math.min(start, total))
  const to = Math.max(from, Math.min(end, total))

  const locate = (offset: number, preferEnd: boolean): { node: Text; offset: number } => {
    for (const entry of nodes) {
      if (preferEnd ? offset > entry.start && offset <= entry.end : offset < entry.end) {
        return { node: entry.node, offset: offset - entry.start }
      }
    }
    const last = nodes[nodes.length - 1]!
    return { node: last.node, offset: preferEnd ? last.node.data.length : 0 }
  }

  const head = locate(from, false)
  const tail = locate(to, true)
  try {
    const range = doc.createRange()
    range.setStart(head.node, head.offset)
    range.setEnd(tail.node, tail.offset)
    return range
  } catch {
    return null
  }
}
