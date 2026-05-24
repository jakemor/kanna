import type { ChatSnapshot, ChatSnapshotMessage } from "../../../shared/session-share/types"

export interface ShareViewPageProps {
  snapshot: ChatSnapshot
}

function MessageView({ message }: { message: ChatSnapshotMessage }) {
  switch (message.kind) {
    case "user_prompt":
      return <div className="kanna-message kanna-message--user">{message.text}</div>
    case "assistant_text":
      return <div className="kanna-message kanna-message--assistant">{message.text}</div>
    case "tool_call":
      return (
        <div className="kanna-message kanna-message--tool-call">
          <code>{message.name}</code>
          <pre>{JSON.stringify(message.input, null, 2)}</pre>
        </div>
      )
    case "tool_result":
      return (
        <pre className="kanna-message kanna-message--tool-result">
          {JSON.stringify(message.output, null, 2)}
        </pre>
      )
    case "diff":
      return <pre className="kanna-message kanna-message--diff">{message.patch}</pre>
    case "terminal_chunk":
      return <pre className="kanna-message kanna-message--terminal">{message.chunk}</pre>
    case "omitted":
      return (
        <div className="kanna-message kanna-message--omitted">
          [content omitted: {message.reason}]
        </div>
      )
  }
}

export function ShareViewPage({ snapshot }: ShareViewPageProps) {
  return (
    <main className="kanna-share-view">
      <header>
        <h1>{snapshot.chatMeta.title}</h1>
        <small>Read-only · model {snapshot.chatMeta.model}</small>
      </header>
      <ol className="kanna-transcript">
        {snapshot.messages.map((m) => (
          <li key={m.id}>
            <MessageView message={m} />
          </li>
        ))}
      </ol>
    </main>
  )
}
