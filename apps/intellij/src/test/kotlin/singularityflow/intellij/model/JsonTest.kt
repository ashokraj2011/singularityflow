package singularityflow.intellij.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class JsonTest {
    @Test
    fun `reads every JSON type and nested values`() {
        val json = Json.parse("""{"a":"x","n":-12.5e1,"i":3,"t":true,"f":false,"z":null,"list":[1,{"b":"y"}],"o":{}}""")
        assertEquals("x", json.string("a"))
        assertEquals(Json.Num(-125.0), json.field("n"))
        assertEquals(3, json.int("i"))
        assertEquals(true, json.bool("t"))
        assertEquals(false, json.bool("f"))
        assertEquals(Json.Null, json.field("z"))
        assertEquals("y", json.array("list")[1].string("b"))
        assertEquals(Json.Obj(emptyMap()), json.field("o"))
    }

    @Test
    fun `decodes escapes including unicode`() {
        assertEquals("q\"\\/\b\u000C\n\r\t é ✓", Json.parse("\"q\\\"\\\\\\/\\b\\f\\n\\r\\t \\u00e9 \\u2713\"").let { (it as Json.Str).value })
    }

    @Test
    fun `accessors are total`() {
        val json = Json.parse("""{"s":1,"n":"x","a":{}}""")
        assertNull(json.string("s"))
        assertNull(json.int("n"))
        assertTrue(json.array("a").isEmpty())
        assertNull(json.field("missing").string("x"))
        assertNull(null.string("x"))
        assertNull(Json.parse("""{"i":1.5}""").int("i"))
    }

    @Test
    fun `slots keep strings and render integers without a decimal point`() {
        assertEquals(mapOf("work" to "FIX-1", "active" to "1", "on" to "true"),
            Json.parse("""{"slots":{"work":"FIX-1","active":1,"on":true,"nested":{}}}""").slots("slots"))
    }

    @Test
    fun `rejects malformed input`() {
        for (bad in listOf("", "{", "[1,]", "{\"a\" 1}", "\"open", "tru", "01", "1.", "{\"a\":1} x", "\"\u0001\"")) {
            try {
                Json.parse(bad)
                fail("accepted: $bad")
            } catch (_: JsonException) {
            }
        }
    }

    @Test
    fun `rejects nesting deeper than the limit`() {
        try {
            Json.parse("[".repeat(200) + "]".repeat(200))
            fail("accepted deep nesting")
        } catch (_: JsonException) {
        }
    }
}
