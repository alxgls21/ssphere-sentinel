/**
 * Self-hosted fonts (no CDN: NOC networks are often air-gapped). Each subset
 * file carries a unicode-range, so the browser downloads only the subsets a
 * page actually uses; Greek is included because customer and site names may
 * be Greek. Add cyrillic-*.css here if a deployment needs it.
 */
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import '@fontsource/jetbrains-mono/latin-ext-400.css'
import '@fontsource/jetbrains-mono/latin-ext-500.css'
import '@fontsource/jetbrains-mono/greek-400.css'
import '@fontsource/jetbrains-mono/greek-500.css'
import '@fontsource/ibm-plex-sans/latin-400.css'
import '@fontsource/ibm-plex-sans/latin-600.css'
import '@fontsource/ibm-plex-sans/latin-ext-400.css'
import '@fontsource/ibm-plex-sans/latin-ext-600.css'
import '@fontsource/ibm-plex-sans/greek-400.css'
import '@fontsource/ibm-plex-sans/greek-600.css'
