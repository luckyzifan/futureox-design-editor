import { createContext } from 'react'
import type { Editor } from './engine'
/** Only document controls opt in; zoom and tool preferences are transient UI state. */
export const PendingEditContext = createContext<Editor | null>(null)
