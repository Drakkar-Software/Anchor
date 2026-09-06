"use client"

import { useEffect,useState } from "react"

import type {
  ConflictAuditEntry,
  ConflictAuditLog,
} from "../mutation/conflictAudit.js"

export function useConflictNotifications(auditLog: ConflictAuditLog) {
  const [conflicts, setConflicts] = useState<ConflictAuditEntry[]>([])

  useEffect(() => auditLog.onConflict((entry) => {
      setConflicts((prev) => [...prev, entry])
    }), [auditLog])

  return {
    clearAll: () => { setConflicts([]); },
    conflicts,

    dismiss: (index: number) =>
      { setConflicts((prev) => prev.filter((_, i) => i !== index)); },
  }
}
