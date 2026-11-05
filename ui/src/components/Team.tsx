/**
 * WHAT IT'S FOR: the Team drawer: every approved member with their name, agent handle and whether
 * their agent is online, plus what they are working on. Agents nobody has named yet are listed too,
 * so it is obvious whose agent is whose. (The dashboard has no owners data, so no feature column.)
 */
import type { Tables } from "../dashboard";
import { teamRows } from "../teamPanel";
import { useIdentity, useMembers } from "../useMembers";

export function TeamView({ tables }: { tables: Tables }) {
  const members = useMembers();
  const identity = useIdentity();
  const rows = teamRows(tables, members, identity);
  if (rows.length === 0) return <p className="muted">Nobody has joined yet.</p>;
  return (
    <section className="d-section">
      <table className="metric-table">
        <thead>
          <tr>
            <th scope="col">Person</th>
            <th scope="col">Agent</th>
            <th scope="col">Status</th>
            <th scope="col">Working on</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.handle}>
              <th scope="row">
                {r.name || <span className="muted">not named yet</span>}
                {r.you && <span className="chip"> you</span>}
              </th>
              <td>
                <code>{r.handle}</code>
              </td>
              <td>{r.online ? "online" : "offline"}</td>
              <td>{r.working || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.some((r) => !r.name) && (
        <p className="muted">
          An unnamed agent was never approved with a name. The owner can run grant … --name &lt;name&gt; for its person.
        </p>
      )}
    </section>
  );
}
