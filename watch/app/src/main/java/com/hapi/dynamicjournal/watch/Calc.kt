package com.hapi.dynamicjournal.watch

import kotlin.math.*

/**
 * Plain calculator maths, as the phone's math blocks write it: + - * / ^ % ( ), "2r" and "2(3)"
 * as times, sqrt sin cos tan ln log abs exp, pi. Returns null when it can't be worked out.
 */
object Calc {
  private val funcs: Map<String, (Double) -> Double> = mapOf(
    "sqrt" to ::sqrt, "sin" to ::sin, "cos" to ::cos, "tan" to ::tan, "ln" to ::ln, "log" to ::log10, "abs" to { x: Double -> abs(x) }, "exp" to ::exp,
  )

  private sealed class Tok {
    data class Num(val v: Double) : Tok()
    data class Op(val c: Char) : Tok()
    data class Fn(val f: (Double) -> Double) : Tok()
  }

  private fun tokens(src: String, vars: Map<String, Double>): List<Tok>? {
    val out = ArrayList<Tok>()
    fun push(t: Tok) {
      val prev = out.lastOrNull()
      val ends = prev is Tok.Num || (prev is Tok.Op && (prev.c == ')' || prev.c == '%'))
      val starts = t is Tok.Fn || t is Tok.Num || (t is Tok.Op && t.c == '(')
      if (ends && starts) out.add(Tok.Op('*'))
      out.add(t)
    }
    var i = 0
    val s = src.replace('×', '*').replace('÷', '/').replace('−', '-')
    while (i < s.length) {
      val c = s[i]
      when {
        c.isWhitespace() || c == ',' -> i++
        c.isDigit() || c == '.' -> {
          var j = i
          while (j < s.length && (s[j].isDigit() || s[j] == '.')) j++
          push(Tok.Num(s.substring(i, j).toDoubleOrNull() ?: return null)); i = j
        }
        c.isLetter() || c == '_' || c == 'π' -> {
          var j = i + 1
          while (j < s.length && (s[j].isLetterOrDigit() || s[j] == '_')) j++
          val w = s.substring(i, j); i = j
          when {
            vars.containsKey(w) -> push(Tok.Num(vars.getValue(w)))
            w == "pi" || w == "π" -> push(Tok.Num(PI))
            funcs.containsKey(w) -> push(Tok.Fn(funcs.getValue(w)))
            else -> return null
          }
        }
        "+-*/^%()".indexOf(c) >= 0 -> { if (c == '(') push(Tok.Op(c)) else out.add(Tok.Op(c)); i++ }
        else -> return null
      }
    }
    return out
  }

  fun eval(src: String, vars: Map<String, Double>): Double? {
    val t = tokens(src, vars) ?: return null
    if (t.isEmpty()) return null
    return try {
      val p = Parser(t)
      val v = p.expr()
      if (p.p != t.size || !v.isFinite()) null else v
    } catch (e: Exception) { null }
  }

  private class Parser(val t: List<Tok>) {
    var p = 0
    fun at(c: Char) = (t.getOrNull(p) as? Tok.Op)?.c == c
    fun expr(): Double {
      var v = term()
      while (at('+') || at('-')) { val op = (t[p++] as Tok.Op).c; val r = term(); v = if (op == '+') v + r else v - r }
      return v
    }
    fun term(): Double {
      var v = unary()
      while (at('*') || at('/')) { val op = (t[p++] as Tok.Op).c; val r = unary(); v = if (op == '*') v * r else v / r }
      return v
    }
    fun unary(): Double = when {
      at('-') -> { p++; -unary() }
      at('+') -> { p++; unary() }
      else -> power()
    }
    fun power(): Double {
      val base = postfix()
      if (at('^')) { p++; return base.pow(unary()) }
      return base
    }
    fun postfix(): Double {
      var v = when (val tok = t.getOrNull(p) ?: throw IllegalStateException("end")) {
        is Tok.Num -> { p++; tok.v }
        is Tok.Fn -> { p++; tok.f(power()) }
        is Tok.Op -> if (tok.c == '(') { p++; val x = expr(); if (!at(')')) throw IllegalStateException("bracket"); p++; x } else throw IllegalStateException("token")
      }
      while (at('%')) { p++; v /= 100 }
      return v
    }
  }
}
