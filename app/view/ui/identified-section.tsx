// Who a lookup says an unsaved number is, waiting on the user: Keep makes the name theirs, Undo
// takes the lookup back and leaves the number unknown again.
import { useMutation } from "@tanstack/react-query"

import type { Queued } from "../answers.ts"
import { confirmMutation, undoMutation } from "../mutations.ts"
import { Cells, percent, SourceLink } from "./cells.tsx"
import { Hand, Stop } from "./marks.tsx"
import { Key, Section } from "./parts.tsx"

export const IdentifiedSection = ({ queued }: { queued: Queued }) => {
  const keep = useMutation(confirmMutation)
  const undo = useMutation(undoMutation)
  const error = keep.error ?? undo.error
  return (
    <Section
      mark={<Hand />}
      label="Identified"
      action={
        <>
          <Key
            go
            disabled={keep.isPending || undo.isPending}
            onClick={() => {
              keep.mutate({ person: queued.id, fields: queued.fields })
            }}
          >
            Keep
          </Key>
          <Key
            disabled={keep.isPending || undo.isPending}
            onClick={() => {
              undo.mutate(queued.batch)
            }}
          >
            Undo
          </Key>
        </>
      }
    >
      <Cells
        label="Name"
        source={<SourceLink source={queued.source} url={queued.url} />}
        sure={percent(queued.confidence)}
      >
        {queued.name}
      </Cells>
      <Cells label="Number">{queued.phone}</Cells>
      {error !== null && <Cells label={<Stop size={12} />}>{error.message}</Cells>}
    </Section>
  )
}
