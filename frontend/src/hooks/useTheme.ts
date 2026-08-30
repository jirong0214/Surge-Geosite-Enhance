import { useEffect, useState } from "react"

type ThemePreference = "light" | "dark" | "system"
type ResolvedTheme = "light" | "dark"

const storageKey = "theme-preference"

const readStoredPreference = (): ThemePreference | null => {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage?.getItem(storageKey) as ThemePreference | null
  } catch {
    return null
  }
}

const getSystemTheme = (): ResolvedTheme => {
  if (typeof window === "undefined") {
    return "light"
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

const applyTheme = (theme: ResolvedTheme) => {
  if (typeof document === "undefined") {
    return
  }
  const root = document.documentElement
  if (theme === "dark") {
    root.classList.add("dark")
  } else {
    root.classList.remove("dark")
  }
}

export const useTheme = () => {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    if (typeof window === "undefined") {
      return "system"
    }
    const stored = readStoredPreference()
    return stored ?? "system"
  })
  const [resolved, setResolved] = useState<ResolvedTheme>(() => {
    if (typeof window === "undefined") {
      return "light"
    }
    const stored = readStoredPreference()
    if (stored && stored !== "system") {
      return stored
    }
    return getSystemTheme()
  })

  useEffect(() => {
    if (typeof window === "undefined") {
      return
    }
    const systemMedia = window.matchMedia("(prefers-color-scheme: dark)")

    const handleSystemChange = () => {
      if (preference === "system") {
        const systemTheme = getSystemTheme()
        setResolved(systemTheme)
        applyTheme(systemTheme)
      }
    }

    handleSystemChange()
    systemMedia.addEventListener("change", handleSystemChange)

    return () => {
      systemMedia.removeEventListener("change", handleSystemChange)
    }
  }, [preference])

  useEffect(() => {
    const nextTheme = preference === "system" ? getSystemTheme() : preference
    setResolved(nextTheme)
    applyTheme(nextTheme)
  }, [preference])

  const updatePreference = (next: ThemePreference) => {
    setPreference(next)
    if (typeof window !== "undefined") {
      try {
        if (next === "system") {
          window.localStorage?.removeItem(storageKey)
        } else {
          window.localStorage?.setItem(storageKey, next)
        }
      } catch {
        // Theme still works for the current session when storage is unavailable.
      }
    }
  }

  return {
    preference,
    resolved,
    setPreference: updatePreference,
  }
}

export type { ThemePreference, ResolvedTheme }
