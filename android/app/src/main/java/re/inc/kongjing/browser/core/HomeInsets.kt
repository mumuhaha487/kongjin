package re.inc.kongjing.browser.core

/** Native fallback for WebViews which report zero CSS safe-area env values. CSS pixels. */
data class HomeInsets(val top: Float = 0f, val left: Float = 0f, val right: Float = 0f, val toolbarHeight: Float = 56f) {
    fun css(): String = ":root{--kj-inset-top:${top}px;--kj-inset-left:${left}px;--kj-inset-right:${right}px;--kj-inset-bottom:0px;--kj-toolbar-height:${toolbarHeight}px}"
    fun html(html: String): String = html.replaceFirst("<head>", "<head><style id=\"kj-native-insets\">${css()}</style>")
    fun script(): String = "(function(){var s=document.getElementById('kj-native-insets');if(!s&&document.head){s=document.createElement('style');s.id='kj-native-insets';document.head.appendChild(s)}if(s)s.textContent='${css()}'})()"
    companion object {
        // A CSS env fallback is used only for an unknown variable, not for a supported zero.
        // max() preserves real safe-area values on newer WebViews and supplies Android 9's zero.
        fun adaptCss(css: String): String = Regex("env\\(safe-area-inset-(top|left|right|bottom)(?:,\\s*0px)?\\)")
            .replace(css) { "max(${it.value}, var(--kj-inset-${it.groupValues[1]}, 0px))" }
    }
}
