package singularityflow.intellij.model

/**
 * A parsed JSON value.
 *
 * The plugin reads output from another process, so it carries its own strict RFC 8259 reader instead
 * of a platform library whose module visibility may change between IDE releases. Every accessor is
 * total: a missing field or a value of an unexpected type reads as absent, never as an exception.
 */
sealed interface Json {
    data class Obj(val fields: Map<String, Json>) : Json
    data class Arr(val items: List<Json>) : Json
    data class Str(val value: String) : Json
    data class Num(val value: Double) : Json
    data class Bool(val value: Boolean) : Json
    data object Null : Json

    companion object {
        fun parse(text: String): Json = JsonReader(text).document()
    }
}

class JsonException(message: String) : RuntimeException(message)

fun Json?.field(key: String): Json? = (this as? Json.Obj)?.fields?.get(key)

fun Json?.string(key: String): String? = (field(key) as? Json.Str)?.value

fun Json?.bool(key: String): Boolean? = (field(key) as? Json.Bool)?.value

fun Json?.int(key: String): Int? = (field(key) as? Json.Num)?.value
    ?.takeIf { it == Math.floor(it) && it >= Int.MIN_VALUE && it <= Int.MAX_VALUE }?.toInt()

fun Json?.array(key: String): List<Json> = (field(key) as? Json.Arr)?.items ?: emptyList()

/** A slot map: strings stay strings, integers render without a decimal point, other values are dropped. */
fun Json?.slots(key: String): Map<String, String> {
    val fields = (field(key) as? Json.Obj)?.fields ?: return emptyMap()
    return fields.mapNotNull { (name, value) ->
        when (value) {
            is Json.Str -> name to value.value
            is Json.Num -> name to (if (value.value == Math.floor(value.value)) value.value.toLong().toString() else value.value.toString())
            is Json.Bool -> name to value.value.toString()
            else -> null
        }
    }.toMap()
}

private class JsonReader(private val text: String) {
    private var index = 0

    fun document(): Json {
        val value = value(depth = 0)
        whitespace()
        if (index != text.length) fail("unexpected trailing content")
        return value
    }

    private fun fail(reason: String): Nothing = throw JsonException("Invalid JSON at offset $index: $reason")

    private fun whitespace() {
        while (index < text.length && text[index] in " \t\n\r") index++
    }

    private fun value(depth: Int): Json {
        if (depth > MAX_DEPTH) fail("nesting deeper than $MAX_DEPTH")
        whitespace()
        if (index >= text.length) fail("unexpected end of input")
        return when (text[index]) {
            '{' -> obj(depth)
            '[' -> arr(depth)
            '"' -> Json.Str(string())
            't' -> literal("true", Json.Bool(true))
            'f' -> literal("false", Json.Bool(false))
            'n' -> literal("null", Json.Null)
            else -> number()
        }
    }

    private fun literal(word: String, value: Json): Json {
        if (!text.startsWith(word, index)) fail("expected $word")
        index += word.length
        return value
    }

    private fun obj(depth: Int): Json {
        index++
        val fields = LinkedHashMap<String, Json>()
        whitespace()
        if (peek() == '}') { index++; return Json.Obj(fields) }
        while (true) {
            whitespace()
            if (peek() != '"') fail("expected a field name")
            val key = string()
            whitespace()
            if (peek() != ':') fail("expected ':'")
            index++
            fields[key] = value(depth + 1)
            whitespace()
            when (peek()) {
                ',' -> index++
                '}' -> { index++; return Json.Obj(fields) }
                else -> fail("expected ',' or '}'")
            }
        }
    }

    private fun arr(depth: Int): Json {
        index++
        val items = ArrayList<Json>()
        whitespace()
        if (peek() == ']') { index++; return Json.Arr(items) }
        while (true) {
            items += value(depth + 1)
            whitespace()
            when (peek()) {
                ',' -> index++
                ']' -> { index++; return Json.Arr(items) }
                else -> fail("expected ',' or ']'")
            }
        }
    }

    private fun peek(): Char? = if (index < text.length) text[index] else null

    private fun string(): String {
        index++
        val out = StringBuilder()
        while (true) {
            if (index >= text.length) fail("unterminated string")
            val c = text[index++]
            when {
                c == '"' -> return out.toString()
                c == '\\' -> {
                    if (index >= text.length) fail("unterminated escape")
                    when (val e = text[index++]) {
                        '"' -> out.append('"')
                        '\\' -> out.append('\\')
                        '/' -> out.append('/')
                        'b' -> out.append('\b')
                        'f' -> out.append('\u000C')
                        'n' -> out.append('\n')
                        'r' -> out.append('\r')
                        't' -> out.append('\t')
                        'u' -> {
                            if (index + 4 > text.length) fail("truncated \\u escape")
                            val hex = text.substring(index, index + 4)
                            out.append(hex.toIntOrNull(16)?.toChar() ?: fail("invalid \\u escape"))
                            index += 4
                        }
                        else -> fail("invalid escape \\$e")
                    }
                }
                c < ' ' -> fail("control character in string")
                else -> out.append(c)
            }
        }
    }

    private fun number(): Json {
        val start = index
        if (peek() == '-') index++
        when (peek()) {
            '0' -> index++
            in '1'..'9' -> while (peek()?.isAsciiDigit() == true) index++
            else -> fail("unexpected character")
        }
        if (peek() == '.') {
            index++
            if (peek()?.isAsciiDigit() != true) fail("expected a digit after '.'")
            while (peek()?.isAsciiDigit() == true) index++
        }
        if (peek() == 'e' || peek() == 'E') {
            index++
            if (peek() == '+' || peek() == '-') index++
            if (peek()?.isAsciiDigit() != true) fail("expected an exponent digit")
            while (peek()?.isAsciiDigit() == true) index++
        }
        return Json.Num(text.substring(start, index).toDouble())
    }

    private fun Char.isAsciiDigit(): Boolean = this in '0'..'9'

    companion object {
        const val MAX_DEPTH = 128
    }
}
