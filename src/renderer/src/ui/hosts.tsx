// Mount once near the root: the shared tooltip bubble, context menus and imperative dialogs.
import { ContextMenuHost } from './ContextMenu'
import { DialogHost } from './Dialog'
import { TooltipHost } from './Tooltip'

export function UIHosts() {
  return (
    <>
      <DialogHost />
      <ContextMenuHost />
      <TooltipHost />
    </>
  )
}
