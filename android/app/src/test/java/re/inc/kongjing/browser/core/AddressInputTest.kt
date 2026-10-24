package re.inc.kongjing.browser.core

import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

@RunWith(Parameterized::class)
class AddressInputTest(private val input: String, private val expectedAddress: String?) {
    @Test fun enterUsesStrictAddressRules() {
        assertEquals(expectedAddress, UrlRules.addressUrl(input))
        assertEquals(expectedAddress ?: UrlRules.searchUrl(input, TEMPLATE), UrlRules.resolve(input, TEMPLATE))
    }

    @Test fun searchIsAlwaysFirstAndOpenIsConditional() {
        val actions = UrlRules.addressActions(input, TEMPLATE)
        assertEquals("搜索：$input", actions.first().label)
        assertEquals(UrlRules.searchUrl(input, TEMPLATE), actions.first().url)
        assertEquals(if (expectedAddress == null) 1 else 2, actions.size)
        if (expectedAddress != null) {
            assertEquals("打开：$expectedAddress", actions[1].label)
            assertEquals(expectedAddress, actions[1].url)
        }
    }

    companion object {
        private const val TEMPLATE = "https://search.example/?q=%s"
        @JvmStatic @Parameterized.Parameters(name = "{0}") fun cases(): List<Array<String?>> = listOf(
            arrayOf("baidu.com", "https://baidu.com/"),
            arrayOf("https://baidu.com", "https://baidu.com/"),
            arrayOf("baidu.com是什么网站", null),
            arrayOf("www.baidu.com/s?wd=天气", null),
            arrayOf("localhost:3000", "http://localhost:3000/"),
            arrayOf("192.168.1.1", "http://192.168.1.1/"),
            arrayOf("localhost", "http://localhost/"),
            arrayOf("LOCALHOST:8080/a?q=x#part", "http://localhost:8080/a?q=x#part"),
            arrayOf("127.0.0.1:8765/a?q=1#ok", "http://127.0.0.1:8765/a?q=1#ok"),
            arrayOf("0.0.0.0", "http://0.0.0.0/"),
            arrayOf("255.255.255.255", "http://255.255.255.255/"),
            arrayOf("http://localhost:3000", "http://localhost:3000/"),
            arrayOf("https://localhost:3000", "https://localhost:3000/"),
            arrayOf("https://192.168.1.1", "https://192.168.1.1/"),
            arrayOf("[::1]:8080", null),
            arrayOf("http://[::1]:8080", "http://[::1]:8080/"),
            arrayOf("hello world", null),
            arrayOf("kongjing.inc.re", "https://kongjing.inc.re/"),
            arrayOf("a.b", null),
            arrayOf("中文.中国", null),
            arrayOf("example.com:443/path?q=ascii#part", "https://example.com:443/path?q=ascii#part"),
            arrayOf("example.com?q=天气", null),
            arrayOf("example.com#天气", null),
            arrayOf("example.com:65536", null),
            arrayOf("999.1.1.1", null),
            arrayOf("-bad.com", null),
            arrayOf("a..com", null),
            arrayOf("good.com@evil.com", null),
            arrayOf("example.com\\evil", null),
            arrayOf("https://example.com/天气", "https://example.com/天气"),
            arrayOf("HTTP://example.com", "http://example.com/"),
            arrayOf("a." + "a".repeat(24), "https://a." + "a".repeat(24) + "/"),
            arrayOf("a." + "a".repeat(25), null),
            arrayOf("example.com/a b", null),
            arrayOf("javascript:alert(1)", null)
        )
    }
}
