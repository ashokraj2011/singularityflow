/*
 * Packaged WEL JUnit 5 source catalog helper.
 *
 * This process parses source as data through the JDK compiler tree API. It never compiles, loads,
 * or executes candidate classes. Input is one repository root followed by repository-relative
 * source paths, one UTF-8 line each. Output is bounded NDJSON consumed by wel-junit5.mjs: one record
 * per test-like method (with its kind, class path, @Disabled state and statically known invocation
 * count), one per lifecycle method, and file gaps. Criterion tags are comments, read by the caller.
 */
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import javax.lang.model.element.Modifier;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;
import com.sun.source.tree.AnnotationTree;
import com.sun.source.tree.AssignmentTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.ImportTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.NewArrayTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;

final class WelJunitCatalog {
  private static final int MAX_SOURCES = 256;
  private static final long MAX_SOURCE_BYTES = 1024L * 1024L;
  private static final int MAX_DECLARATIONS = 10_000;
  private static final String TEST = "org.junit.jupiter.api.Test";
  private static final String NESTED = "org.junit.jupiter.api.Nested";
  private static final String DISABLED = "org.junit.jupiter.api.Disabled";
  private static final String PARAMETERIZED = "org.junit.jupiter.params.ParameterizedTest";
  private static final String REPEATED = "org.junit.jupiter.api.RepeatedTest";
  private static final String FACTORY = "org.junit.jupiter.api.TestFactory";
  private static final String TEMPLATE = "org.junit.jupiter.api.TestTemplate";
  private static final Set<String> LIFECYCLE = Set.of(
    "org.junit.jupiter.api.AfterEach",
    "org.junit.jupiter.api.AfterAll",
    "org.junit.jupiter.api.BeforeEach",
    "org.junit.jupiter.api.BeforeAll"
  );
  private static final String PARAMS = "org.junit.jupiter.params.provider.";
  private static final Set<String> KNOWN = Set.of(
    TEST, NESTED, DISABLED, PARAMETERIZED, REPEATED, FACTORY, TEMPLATE,
    "org.junit.jupiter.api.AfterEach", "org.junit.jupiter.api.AfterAll",
    "org.junit.jupiter.api.BeforeEach", "org.junit.jupiter.api.BeforeAll",
    PARAMS + "ValueSource", PARAMS + "CsvSource", PARAMS + "NullSource", PARAMS + "EmptySource",
    PARAMS + "NullAndEmptySource", PARAMS + "MethodSource", PARAMS + "EnumSource",
    PARAMS + "ArgumentsSource", PARAMS + "CsvFileSource", PARAMS + "FieldSource"
  );

  // JUnit 4 and TestNG names that a wildcard import could equally supply; their presence makes a
  // simple annotation name ambiguous rather than silently Jupiter.
  private static final Set<String> RIVALS = Set.of(
    "org.junit.Test", "org.junit.Before", "org.junit.After", "org.junit.BeforeClass",
    "org.junit.AfterClass", "org.junit.Ignore", "org.testng.annotations.Test"
  );

  private static String json(String value) {
    StringBuilder output = new StringBuilder("\"");
    for (int index = 0; index < value.length(); index += 1) {
      char character = value.charAt(index);
      switch (character) {
        case '\\': output.append("\\\\"); break;
        case '"': output.append("\\\""); break;
        case '\b': output.append("\\b"); break;
        case '\f': output.append("\\f"); break;
        case '\n': output.append("\\n"); break;
        case '\r': output.append("\\r"); break;
        case '\t': output.append("\\t"); break;
        default:
          if (character < 0x20) output.append(String.format("\\u%04x", (int) character));
          else output.append(character);
      }
    }
    return output.append('"').toString();
  }

  private static String jsonList(List<String> values) {
    return "[" + values.stream().map(WelJunitCatalog::json).collect(Collectors.joining(",")) + "]";
  }

  private static void gap(String path, String code) {
    System.out.println("{\"kind\":\"gap\",\"path\":" + json(path)
      + ",\"code\":" + json(code) + "}");
  }

  private static Set<String> imports(CompilationUnitTree unit) {
    Set<String> result = new HashSet<>();
    for (ImportTree imported : unit.getImports()) {
      if (!imported.isStatic()) result.add(imported.getQualifiedIdentifier().toString());
    }
    return result;
  }

  /** The fully qualified annotation name, or the written name when it cannot be resolved. */
  private static String annotationName(AnnotationTree annotation, Set<String> imports) {
    String written = annotation.getAnnotationType().toString();
    if (written.contains(".")) return written;
    List<String> candidates = new ArrayList<>();
    for (String imported : imports) {
      if (imported.endsWith("." + written)) candidates.add(imported);
      if (imported.endsWith(".*")) {
        String candidate = imported.substring(0, imported.length() - 1) + written;
        if (KNOWN.contains(candidate) || RIVALS.contains(candidate)) candidates.add(candidate);
      }
    }
    return candidates.size() == 1 ? candidates.get(0) : written;
  }

  /** The number of literal values in one annotation attribute, or -1 when it is not literal. */
  private static int literalCount(ExpressionTree value) {
    if (value instanceof NewArrayTree) {
      NewArrayTree array = (NewArrayTree) value;
      if (array.getInitializers() == null) return -1;
      for (ExpressionTree element : array.getInitializers()) {
        if (!(element instanceof LiteralTree)) return -1;
      }
      return array.getInitializers().size();
    }
    return value instanceof LiteralTree ? 1 : -1;
  }

  private static ExpressionTree attribute(ExpressionTree argument, List<String> names) {
    if (argument instanceof AssignmentTree) {
      AssignmentTree assignment = (AssignmentTree) argument;
      return names.contains(assignment.getVariable().toString()) ? assignment.getExpression() : null;
    }
    return names.contains("value") ? argument : null;
  }

  /** The statically known invocation count of a parameterized or repeated test, or -1. */
  private static int staticCount(MethodTree node, Set<String> imports, String kind) {
    int total = 0;
    boolean sourced = false;
    for (AnnotationTree annotation : node.getModifiers().getAnnotations()) {
      String name = annotationName(annotation, imports);
      if (kind.equals("repeated") && name.equals(REPEATED)) {
        for (ExpressionTree argument : annotation.getArguments()) {
          ExpressionTree value = attribute(argument, List.of("value"));
          if (value instanceof LiteralTree && ((LiteralTree) value).getValue() instanceof Integer) {
            return (Integer) ((LiteralTree) value).getValue();
          }
        }
        return -1;
      }
      if (!kind.equals("parameterized") || !name.startsWith(PARAMS)) continue;
      String simple = name.substring(PARAMS.length());
      sourced = true;
      switch (simple) {
        case "NullSource": case "EmptySource": total += 1; break;
        case "NullAndEmptySource": total += 2; break;
        case "ValueSource": {
          int found = -1;
          for (ExpressionTree argument : annotation.getArguments()) {
            if (!(argument instanceof AssignmentTree)) return -1;
            int count = literalCount(((AssignmentTree) argument).getExpression());
            if (count < 0 || found >= 0) return -1;
            found = count;
          }
          if (found < 0) return -1;
          total += found;
          break;
        }
        case "CsvSource": {
          int found = -1;
          for (ExpressionTree argument : annotation.getArguments()) {
            ExpressionTree value = attribute(argument, List.of("value"));
            if (value == null) {
              if (argument instanceof AssignmentTree
                  && List.of("delimiter", "delimiterString", "quoteCharacter", "emptyValue", "nullValues",
                    "ignoreLeadingAndTrailingWhitespace", "maxCharsPerColumn")
                    .contains(((AssignmentTree) argument).getVariable().toString())) continue;
              return -1;
            }
            found = literalCount(value);
            if (found < 0) return -1;
          }
          if (found < 0) return -1;
          total += found;
          break;
        }
        default: return -1;
      }
    }
    return kind.equals("parameterized") && sourced ? total : -1;
  }

  private static void emitDeclaration(String path, String packageName, List<String> classPath, MethodTree node,
      String kind, boolean disabled, int count, long start, long end, List<String> problems, boolean nestedRunnable) {
    String parameters = node.getParameters().stream().map(parameter -> parameter.getType().toString())
      .collect(Collectors.joining(","));
    System.out.println("{\"kind\":\"declaration\",\"path\":" + json(path)
      + ",\"packageName\":" + json(packageName)
      + ",\"classPath\":" + jsonList(classPath)
      + ",\"methodName\":" + json(node.getName().toString())
      + ",\"signature\":" + json("(" + parameters + ")"
        + (node.getReturnType() == null ? "" : node.getReturnType().toString()))
      + ",\"testKind\":" + json(kind)
      + ",\"disabled\":" + disabled
      + ",\"staticCount\":" + count
      + ",\"nestedRunnable\":" + nestedRunnable
      + ",\"problems\":" + jsonList(problems)
      + ",\"start\":" + start + ",\"end\":" + end + "}");
  }

  private static void emitLifecycle(String path, List<String> classPath, String annotation, long start, long end) {
    System.out.println("{\"kind\":\"lifecycle\",\"path\":" + json(path)
      + ",\"classPath\":" + jsonList(classPath)
      + ",\"annotation\":" + json(annotation)
      + ",\"start\":" + start + ",\"end\":" + end + "}");
  }

  private static int parse(Path root, String relative, Path source, JavaCompiler compiler) throws IOException {
    DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
    try (StandardJavaFileManager files = compiler.getStandardFileManager(
      diagnostics, null, StandardCharsets.UTF_8
    )) {
      Iterable<? extends JavaFileObject> units = files.getJavaFileObjects(source.toFile());
      JavacTask task = (JavacTask) compiler.getTask(
        null, files, diagnostics, List.of("-proc:none", "-encoding", "UTF-8"), null, units
      );
      List<CompilationUnitTree> parsed = new ArrayList<>();
      task.parse().forEach(parsed::add);
      if (parsed.size() != 1 || diagnostics.getDiagnostics().stream()
          .anyMatch(item -> item.getKind() == Diagnostic.Kind.ERROR)) {
        gap(relative, "JAVA_PARSER_DIAGNOSTIC");
        return 0;
      }
      CompilationUnitTree unit = parsed.get(0);
      Set<String> imports = imports(unit);
      String packageName = unit.getPackageName() == null ? "" : unit.getPackageName().toString();
      if (packageName.isEmpty()) {
        gap(relative, "JAVA_PACKAGE_IDENTITY_UNAVAILABLE");
        return 0;
      }
      long topLevel = unit.getTypeDecls().stream().filter(tree -> tree instanceof ClassTree).count();
      if (topLevel != 1) {
        gap(relative, "JAVA_TOP_LEVEL_CLASS_AMBIGUOUS");
        return 0;
      }
      Trees trees = Trees.instance(task);
      SourcePositions positions = trees.getSourcePositions();
      int[] emitted = {0};
      // classPath: the top-level class, then each enclosing nested class. runnable: every class
      // on the path below the top level is a JUnit @Nested class, so Jupiter runs its tests.
      List<String> classPath = new ArrayList<>();
      List<Boolean> runnable = new ArrayList<>();
      List<Boolean> disabledClasses = new ArrayList<>();
      new TreePathScanner<Void, Void>() {
        @Override public Void visitClass(ClassTree node, Void unused) {
          boolean nested = false;
          boolean disabled = false;
          for (AnnotationTree annotation : node.getModifiers().getAnnotations()) {
            String name = annotationName(annotation, imports);
            if (name.equals(NESTED)) nested = true;
            if (name.equals(DISABLED)) disabled = true;
          }
          classPath.add(node.getSimpleName().toString());
          runnable.add(classPath.size() == 1 || (nested && !node.getModifiers().getFlags().contains(Modifier.STATIC)
            && runnable.get(runnable.size() - 1)));
          disabledClasses.add(disabled);
          Void result = super.visitClass(node, unused);
          classPath.remove(classPath.size() - 1);
          runnable.remove(runnable.size() - 1);
          disabledClasses.remove(disabledClasses.size() - 1);
          return result;
        }

        @Override public Void visitMethod(MethodTree node, Void unused) {
          if (classPath.isEmpty()) return super.visitMethod(node, unused);
          String kind = null;
          boolean disabled = disabledClasses.contains(Boolean.TRUE);
          String lifecycle = null;
          for (AnnotationTree annotation : node.getModifiers().getAnnotations()) {
            String name = annotationName(annotation, imports);
            if (name.equals(TEST)) kind = kind == null ? "test" : "conflict";
            else if (name.equals(PARAMETERIZED)) kind = kind == null ? "parameterized" : "conflict";
            else if (name.equals(REPEATED)) kind = kind == null ? "repeated" : "conflict";
            else if (name.equals(FACTORY)) kind = kind == null ? "factory" : "conflict";
            else if (name.equals(TEMPLATE)) kind = kind == null ? "template" : "conflict";
            else if (name.equals(DISABLED)) disabled = true;
            else if (LIFECYCLE.contains(name)) lifecycle = name.substring(name.lastIndexOf('.') + 1);
          }
          long start = positions.getStartPosition(unit, node);
          long end = positions.getEndPosition(unit, node);
          if (lifecycle != null && kind == null && start >= 0 && end > start) {
            emitLifecycle(relative, List.copyOf(classPath), lifecycle, start, end);
          }
          if (kind == null) return super.visitMethod(node, unused);
          List<String> problems = new ArrayList<>();
          if (kind.equals("conflict")) problems.add("CONFLICTING_TEST_ANNOTATIONS");
          if (node.getBody() == null || node.getModifiers().getFlags().contains(Modifier.ABSTRACT)) problems.add("ABSTRACT_TEST");
          if (node.getModifiers().getFlags().contains(Modifier.STATIC)
              || node.getModifiers().getFlags().contains(Modifier.PRIVATE)) problems.add("NOT_A_RUNNABLE_TEST");
          if (lifecycle != null) problems.add("CONFLICTING_TEST_ANNOTATIONS");
          if (start < 0 || end <= start) problems.add("SOURCE_RANGE_UNAVAILABLE");
          int count = kind.equals("parameterized") || kind.equals("repeated") ? staticCount(node, imports, kind) : -1;
          emitDeclaration(relative, packageName, List.copyOf(classPath), node, kind, disabled, count,
            Math.max(start, 0), Math.max(end, 0), problems, runnable.get(runnable.size() - 1));
          emitted[0] += 1;
          return super.visitMethod(node, unused);
        }
      }.scan(unit, null);
      return emitted[0];
    }
  }

  public static void main(String[] ignored) throws Exception {
    BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    String rootLine = input.readLine();
    if (rootLine == null || rootLine.isBlank()) throw new IllegalArgumentException("repository root missing");
    Path root = Path.of(rootLine).toAbsolutePath().normalize();
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    if (compiler == null) throw new IllegalStateException("JDK compiler unavailable");
    List<String> paths = input.lines().collect(Collectors.toList());
    if (paths.size() > MAX_SOURCES) throw new IllegalArgumentException("source count exceeds " + MAX_SOURCES);
    int declarations = 0;
    for (String relative : paths) {
      if (relative.isBlank() || relative.indexOf('\0') >= 0 || relative.contains("\\")) {
        gap(relative, "SOURCE_PATH_INVALID");
        continue;
      }
      Path source = root.resolve(relative).normalize();
      if (!source.startsWith(root) || Files.isSymbolicLink(source)
          || !Files.isRegularFile(source, LinkOption.NOFOLLOW_LINKS)
          || Files.size(source) > MAX_SOURCE_BYTES) {
        gap(relative, "SOURCE_PATH_UNAVAILABLE");
        continue;
      }
      declarations += parse(root, relative, source, compiler);
      if (declarations > MAX_DECLARATIONS) {
        throw new IllegalArgumentException("declaration count exceeds " + MAX_DECLARATIONS);
      }
    }
  }
}
