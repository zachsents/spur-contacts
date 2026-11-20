// One person, with every fact, where it came from and how sure that is; what's suggested, the
// identification waiting on the user, their lookups, their records in other books, and every
// change to them with its undo.
import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQuery,
  useSuspenseQuery,
} from "@tanstack/react-query"

import { useSeen } from "../bridge.ts"
import { enrichKey, enrichMutation } from "../mutations.ts"
import { identifiedQuery, personQuery } from "../queries.ts"
import { Boundary } from "./boundary.tsx"
import { DetailsSection } from "./details-section.tsx"
import { FieldsSection } from "./fields-section.tsx"
import { HistorySection } from "./history-section.tsx"
import { IdentifiedSection } from "./identified-section.tsx"
import { LookupSection } from "./lookup-section.tsx"
import { Runner } from "./marks.tsx"
import { Key } from "./parts.tsx"
import { RecordsSection } from "./records-section.tsx"
import { SuggestedSection } from "./suggested-section.tsx"

export const PersonPage = ({ person }: { person: string }) => {
  const { data: p } = useSuspenseQuery(personQuery(person))
  const queued = useQuery({
    ...identifiedQuery,
    select: (d) => d.queue.find((q) => q.id === p.id),
  }).data
  const lookup = useMutation(enrichMutation(p.id))
  // A lookup started here, from the menu bar or by the agent through the window.
  const running = useIsMutating({ mutationKey: enrichKey(p.id) }) > 0
  const failed = useMutationState({
    filters: { mutationKey: enrichKey(p.id) },
    select: (m) => (m.state.status === "error" ? (m.state.error?.message ?? null) : null),
  }).at(-1)
  useSeen("contacts/person", p.id)
  return (
    <article className="min-h-full bg-paper">
      <header className="flex h-head items-center gap-3 px-inset hairline-b">
        <h2 className="selectable m-0 min-w-0 flex-1 truncate text-name font-semibold">{p.name}</h2>
        {running && <Runner />}
        <Key
          disabled={running}
          onClick={() => {
            lookup.mutate()
          }}
        >
          Look Up
        </Key>
      </header>
      {queued !== undefined && (
        <Boundary>
          <IdentifiedSection queued={queued} />
        </Boundary>
      )}
      <Boundary>
        <DetailsSection person={p} />
      </Boundary>
      <Boundary>
        <FieldsSection person={p} />
      </Boundary>
      <Boundary>
        <SuggestedSection person={p} />
      </Boundary>
      <Boundary>
        <LookupSection person={p} error={failed ?? null} />
      </Boundary>
      <Boundary>
        <RecordsSection person={p} />
      </Boundary>
      <Boundary>
        <HistorySection person={p.id} />
      </Boundary>
    </article>
  )
}
