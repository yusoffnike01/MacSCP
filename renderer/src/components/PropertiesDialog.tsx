import { useEffect, useState, type ReactNode } from "react";
import type {
  Principal,
  Principals,
  PropertyChanges,
  RemoteFileType,
  RemoteStat,
} from "../types";
import { errorMessage, formatSize } from "../format";

const CLASSES = [
  { label: "Owner", shift: 6 },
  { label: "Group", shift: 3 },
  { label: "Others", shift: 0 },
] as const;

const ACCESS = [
  { label: "Read", value: 4 },
  { label: "Write", value: 2 },
  { label: "Execute", value: 1 },
] as const;

const SPECIAL_BITS = [
  { label: "Set UID", bit: 0o4000 },
  { label: "Set GID", bit: 0o2000 },
  { label: "Sticky bit", bit: 0o1000 },
] as const;

const TYPE_LABELS: Record<RemoteFileType, string> = {
  file: "File",
  directory: "Folder",
  symlink: "Symbolic link",
  other: "Special file",
};

const TYPE_ICONS: Record<RemoteFileType, string> = {
  file: "📄",
  directory: "📁",
  symlink: "🔗",
  other: "⚙️",
};

const fieldClass =
  "w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-text-primary outline-none focus:border-accent";

const toOctal = (mode: number) => mode.toString(8).padStart(4, "0");

// ls -l style, e.g. "rwxr-sr-x".
function toSymbolic(mode: number): string {
  const part = (shift: number, specialBit: number, specialChar: string) => {
    const bits = (mode >> shift) & 7;
    const execute = bits & 1;
    const x =
      mode & specialBit
        ? execute
          ? specialChar
          : specialChar.toUpperCase()
        : execute
          ? "x"
          : "-";
    return (bits & 4 ? "r" : "-") + (bits & 2 ? "w" : "-") + x;
  };
  return part(6, 0o4000, "s") + part(3, 0o2000, "s") + part(0, 0o1000, "t");
}

function describeId(id: number, list: Principal[]): string {
  const name = list.find((p) => p.id === id)?.name;
  return name ? `${name} (${id})` : String(id);
}

export function PropertiesDialog({
  sessionId,
  path,
  onClose,
}: {
  sessionId: string;
  path: string;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<RemoteStat | null>(null);
  const [principals, setPrincipals] = useState<Principals>({
    users: [],
    groups: [],
  });
  const [loadError, setLoadError] = useState<string | null>(null);

  const [mode, setMode] = useState(0);
  const [octalText, setOctalText] = useState("");
  const [uid, setUid] = useState(0);
  const [gid, setGid] = useState(0);
  const [recursivePermissions, setRecursivePermissions] = useState(false);
  const [recursiveOwnership, setRecursiveOwnership] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.api.sftp.stat(sessionId, path),
      window.api.sftp.principals(sessionId),
    ])
      .then(([stat, list]) => {
        if (cancelled) return;
        setInfo(stat);
        setPrincipals(list);
        setMode(stat.permissions);
        setOctalText(toOctal(stat.permissions));
        setUid(stat.uid);
        setGid(stat.gid);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, path]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const name = path.split("/").filter(Boolean).pop() ?? "/";
  const location = path.slice(0, path.lastIndexOf("/")) || "/";
  // A symlink's own permissions mean nothing, and chmod/chown over SFTP
  // would change its target instead, so links are shown read-only.
  const editable = info !== null && info.type !== "symlink";
  const isFolder = info?.type === "directory";
  const octalValid = /^[0-7]{3,4}$/.test(octalText);
  const permissionsChanged = info !== null && mode !== info.permissions;
  const ownershipChanged =
    info !== null && (uid !== info.uid || gid !== info.gid);
  const canApply =
    editable &&
    octalValid &&
    !saving &&
    (permissionsChanged ||
      ownershipChanged ||
      recursivePermissions ||
      recursiveOwnership);

  function updateMode(next: number) {
    setMode(next);
    setOctalText(toOctal(next));
  }

  function handleOctalChange(text: string) {
    const digits = text.replace(/[^0-7]/g, "").slice(0, 4);
    setOctalText(digits);
    if (/^[0-7]{3,4}$/.test(digits)) setMode(parseInt(digits, 8));
  }

  async function handleApply() {
    const changes: PropertyChanges = {};
    if (permissionsChanged || recursivePermissions) {
      changes.permissions = mode;
      changes.recursivePermissions = isFolder && recursivePermissions;
    }
    if (ownershipChanged || recursiveOwnership) {
      changes.uid = uid;
      changes.gid = gid;
      changes.recursiveOwnership = isFolder && recursiveOwnership;
    }
    setSaving(true);
    setError(null);
    try {
      await window.api.sftp.setProperties(sessionId, path, changes);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="properties-title"
        className="flex max-h-[90vh] w-[460px] flex-col rounded-2xl border border-border-subtle bg-surface-1 shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-border-subtle px-6 py-4">
          <span className="text-2xl">{info ? TYPE_ICONS[info.type] : "📄"}</span>
          <div className="min-w-0">
            <h2
              id="properties-title"
              className="truncate text-base font-semibold text-text-primary"
            >
              {name}
            </h2>
            <p className="text-xs text-text-muted">
              {info ? TYPE_LABELS[info.type] : "Loading…"} · Properties
            </p>
          </div>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {loadError ? (
            <p className="text-sm text-danger">{loadError}</p>
          ) : !info ? (
            <p className="text-sm text-text-muted">Loading…</p>
          ) : (
            <>
              <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2 text-sm">
                <dt className="text-text-muted">Location</dt>
                <dd className="break-all font-mono text-xs leading-5 text-text-secondary">
                  {location}
                </dd>
                {info.type === "file" && (
                  <>
                    <dt className="text-text-muted">Size</dt>
                    <dd className="text-text-secondary">
                      {info.size < 1024
                        ? `${info.size} bytes`
                        : `${formatSize(info.size)} (${info.size.toLocaleString()} bytes)`}
                    </dd>
                  </>
                )}
                <dt className="text-text-muted">Modified</dt>
                <dd className="text-text-secondary">
                  {new Date(info.modifiedAt).toLocaleString()}
                </dd>
                {info.type === "symlink" && (
                  <>
                    <dt className="text-text-muted">Links to</dt>
                    <dd className="break-all font-mono text-xs leading-5 text-text-secondary">
                      {info.linkTarget ?? "unknown"}
                    </dd>
                  </>
                )}
                {!editable && (
                  <>
                    <dt className="text-text-muted">Owner</dt>
                    <dd className="text-text-secondary">
                      {describeId(info.uid, principals.users)}
                    </dd>
                    <dt className="text-text-muted">Group</dt>
                    <dd className="text-text-secondary">
                      {describeId(info.gid, principals.groups)}
                    </dd>
                  </>
                )}
              </dl>

              {editable && (
                <>
                  <Section title="Ownership">
                    <div className="grid grid-cols-[88px_1fr] items-center gap-x-3 gap-y-2">
                      <label htmlFor="prop-owner" className="text-sm text-text-muted">
                        Owner
                      </label>
                      <PrincipalPicker
                        id="prop-owner"
                        value={uid}
                        options={principals.users}
                        onChange={setUid}
                      />
                      <label htmlFor="prop-group" className="text-sm text-text-muted">
                        Group
                      </label>
                      <PrincipalPicker
                        id="prop-group"
                        value={gid}
                        options={principals.groups}
                        onChange={setGid}
                      />
                    </div>
                  </Section>

                  <Section title="Permissions">
                    <table className="w-full text-sm">
                      <thead>
                        <tr>
                          <th />
                          {ACCESS.map((access) => (
                            <th
                              key={access.label}
                              className="pb-1 text-center text-xs font-medium text-text-muted"
                            >
                              {access.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {CLASSES.map((cls) => (
                          <tr key={cls.label}>
                            <td className="py-1 text-text-secondary">{cls.label}</td>
                            {ACCESS.map((access) => {
                              const bit = access.value << cls.shift;
                              return (
                                <td key={access.label} className="py-1 text-center">
                                  <input
                                    type="checkbox"
                                    aria-label={`${cls.label} ${access.label}`}
                                    checked={(mode & bit) !== 0}
                                    onChange={() => updateMode(mode ^ bit)}
                                    className="h-4 w-4 accent-accent"
                                  />
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
                      {SPECIAL_BITS.map((special) => (
                        <label
                          key={special.label}
                          className="flex items-center gap-2 text-sm text-text-secondary"
                        >
                          <input
                            type="checkbox"
                            checked={(mode & special.bit) !== 0}
                            onChange={() => updateMode(mode ^ special.bit)}
                            className="h-4 w-4 accent-accent"
                          />
                          {special.label}
                        </label>
                      ))}
                    </div>

                    <div className="mt-3 flex items-center gap-3">
                      <label htmlFor="prop-octal" className="text-sm text-text-muted">
                        Octal
                      </label>
                      <input
                        id="prop-octal"
                        value={octalText}
                        inputMode="numeric"
                        spellCheck={false}
                        onChange={(e) => handleOctalChange(e.target.value)}
                        onBlur={() => setOctalText(toOctal(mode))}
                        className={`w-20 rounded-lg border bg-surface-2 px-2 py-1.5 font-mono text-sm text-text-primary outline-none ${
                          octalValid
                            ? "border-border-subtle focus:border-accent"
                            : "border-danger"
                        }`}
                      />
                      <span className="font-mono text-sm text-text-secondary">
                        {toSymbolic(mode)}
                      </span>
                    </div>
                  </Section>

                  {isFolder && (
                    <Section title="Apply to everything inside">
                      <label className="flex items-start gap-2 text-sm text-text-secondary">
                        <input
                          type="checkbox"
                          checked={recursivePermissions}
                          onChange={(e) => setRecursivePermissions(e.target.checked)}
                          className="mt-0.5 h-4 w-4 accent-accent"
                        />
                        <span>
                          Permissions
                          <span className="block text-xs text-text-muted">
                            Folders also get Execute wherever Read is set, so they
                            stay openable. Special bits go to folders only.
                          </span>
                        </span>
                      </label>
                      <label className="mt-2 flex items-center gap-2 text-sm text-text-secondary">
                        <input
                          type="checkbox"
                          checked={recursiveOwnership}
                          onChange={(e) => setRecursiveOwnership(e.target.checked)}
                          className="h-4 w-4 accent-accent"
                        />
                        Owner and group
                      </label>
                    </Section>
                  )}
                </>
              )}

              {error && (
                <p className="whitespace-pre-wrap break-words text-xs text-danger">
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border-subtle px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
          >
            {editable ? "Cancel" : "Close"}
          </button>
          {editable && (
            <button
              onClick={handleApply}
              disabled={!canApply}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface-0 transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Applying…" : "Apply"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}

function PrincipalPicker({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: number;
  options: Principal[];
  onChange: (id: number) => void;
}) {
  if (options.length === 0) {
    // Names unavailable (e.g. /etc/passwd unreadable): edit the numeric ID.
    return (
      <input
        id={id}
        type="number"
        min={0}
        value={value}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (e.target.value !== "" && Number.isInteger(next) && next >= 0) {
            onChange(next);
          }
        }}
        className={fieldClass}
      />
    );
  }
  // Keep the current ID selectable even when no name maps to it.
  const list = options.some((p) => p.id === value)
    ? options
    : [{ name: "", id: value }, ...options];
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className={fieldClass}
    >
      {list.map((p) => (
        <option key={`${p.name}:${p.id}`} value={p.id}>
          {p.name ? `${p.name} (${p.id})` : String(p.id)}
        </option>
      ))}
    </select>
  );
}
