/**
 * Tool category map for the MCP process.
 *
 * Mirrors the categories defined in electron/services/ai/tool-registry.ts.
 * Used to send category info with approval requests without importing
 * from the Electron main process.
 */

export const TOOL_CATEGORIES: Record<string, string> = {
  // Terminal
  terminal_execute: 'execute',
  terminal_read_pane: 'read',
  terminal_send_keys: 'execute',
  local_shell_create: 'execute',

  // Connection
  connection_list: 'read',
  connection_open: 'connection',
  connection_close: 'connection',

  // Credential
  credential_list: 'read',
  credential_create: 'write',
  credential_read: 'credential',
  credential_delete: 'write',

  // Web session
  website_screenshot: 'read',
  website_read_content: 'read',
  website_navigate: 'navigate',
  website_click: 'execute',
  website_type: 'execute',
  website_send_key: 'execute',
  website_mouse_move: 'execute',
  website_mouse_drag: 'execute',
  website_mouse_scroll: 'execute',
  website_get_dimensions: 'read',
  website_click_element: 'execute',
  website_fill_input: 'execute',
  website_get_elements: 'read',
  website_execute_js: 'execute',
  website_list_tabs: 'read',
  website_create_tab: 'navigate',
  website_close_tab: 'navigate',
  website_switch_tab: 'navigate',
  website_go_back: 'navigate',
  website_go_forward: 'navigate',
  website_reload: 'navigate',

  // RDP
  rdp_screenshot: 'read',
  rdp_click: 'execute',
  rdp_type: 'execute',
  rdp_send_key: 'execute',
  rdp_mouse_move: 'execute',
  rdp_mouse_drag: 'execute',
  rdp_mouse_scroll: 'execute',
  rdp_resize: 'execute',
  rdp_get_dimensions: 'read',

  // Entry
  entry_info: 'read',
  document_read: 'read',
  entry_update_notes: 'write',
  document_create: 'write',
  document_update: 'write',

  // VNC
  vnc_screenshot: 'read',
  vnc_click: 'execute',
  vnc_type: 'execute',
  vnc_send_key: 'execute',
  vnc_mouse_move: 'execute',
  vnc_mouse_drag: 'execute',
  vnc_mouse_scroll: 'execute',
  vnc_get_dimensions: 'read',

  // Command
  command_execute: 'execute',
};
