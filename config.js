// Gazin Market Deployment Config
// -----------------------------------------------------------------------------
// LOCAL MODE (default): Leave supabaseUrl and supabaseAnonKey empty ("") to use
// the local server (start.bat / server.py / local_server.ps1).
//
// FREE CLOUD MODE (Netlify / Vercel / GitHub Pages + Supabase):
// 1. Create a free project at https://supabase.com
// 2. Run supabase_schema.sql in Supabase SQL Editor
// 3. Paste your Project URL and Publishable/Anon key below (NEVER put service_role here!)
// 4. Drag-and-drop the `public` folder onto https://app.netlify.com/drop
// -----------------------------------------------------------------------------
window.GAZIN_CONFIG = {
  supabaseUrl: "https://tdujkhzpxcbhcxvzmddj.supabase.co",
  supabaseAnonKey: "sb_publishable_08W9l5e_OBZfNSdpLtMqeQ_VCAkseIH"
};
