/*
 * Packaged WEL JUnit 5 source catalog helper.
 *
 * This process parses source as data through the JDK compiler tree API. It never compiles, loads,
 * or executes candidate classes. Input is one repository root followed by repository-relative
 * source paths, one UTF-8 line each. Output is bounded NDJSON consumed by wel-junit5.mjs.
 */
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
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
import com.sun.source.tree.Tree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;

final class WelJunitCatalog {
  private static final int MAX_SOURCES = 256;
  private static final long MAX_SOURCE_BYTES = 1024L * 1024L;
  private static final int MAX_DECLARATIONS = 10_000;
  private static final String TEST = "org.junit.jupiter.api.Test";
  private static final String TAG = "org.junit.jupiter.api.Tag";
  private static final Set<String> UNSUPPORTED = Set.of(
    "org.junit.jupiter.params.ParameterizedTest",
    "org.junit.jupiter.api.RepeatedTest",
    "org.junit.jupiter.api.TestFactory",
    "org.junit.jupiter.api.TestTemplate",
    "org.junit.jupiter.api.Nested"
  );
  private static final Set<String> LIFECYCLE = Set.of(
    "org.junit.jupiter.api.AfterEach",
    "org.junit.jupiter.api.AfterAll",
    "org.junit.jupiter.api.BeforeEach",
    "org.junit.jupiter.api.BeforeAll"
  );

  private static final class Declaration {
    private final String path;
    private final String packageName;
    private final String className;
    private final String methodName;
    private final String signature;
    private final long start;
    private final long end;
    private final List<String> clauseIds;

    Declaration(String path, String packageName, String className, String methodName,
                String signature, long start, long end, List<String> clauseIds) {
      this.path = path;
      this.packageName = packageName;
      this.className = className;
      this.methodName = methodName;
      this.signature = signature;
      this.start = start;
      this.end = end;
      this.clauseIds = clauseIds;
    }
    String path() { return path; }
    String packageName() { return packageName; }
    String className() { return className; }
    String methodName() { return methodName; }
    String signature() { return signature; }
    long start() { return start; }
    long end() { return end; }
    List<String> clauseIds() { return clauseIds; }
  }

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

  private static void gap(String path, String code) {
    System.out.println("{\"kind\":\"gap\",\"path\":" + json(path)
      + ",\"code\":" + json(code) + "}");
  }

  private static void declaration(Declaration value) {
    String clauses = value.clauseIds().stream().map(WelJunitCatalog::json)
      .reduce((left, right) -> left + "," + right).orElse("");
    System.out.println("{\"kind\":\"declaration\",\"path\":" + json(value.path())
      + ",\"packageName\":" + json(value.packageName())
      + ",\"className\":" + json(value.className())
      + ",\"methodName\":" + json(value.methodName())
      + ",\"signature\":" + json(value.signature())
      + ",\"start\":" + value.start() + ",\"end\":" + value.end()
      + ",\"clauseIds\":[" + clauses + "]}");
  }

  private static Set<String> imports(CompilationUnitTree unit) {
    Set<String> result = new HashSet<>();
    for (ImportTree imported : unit.getImports()) {
      if (!imported.isStatic()) result.add(imported.getQualifiedIdentifier().toString());
    }
    return result;
  }

  private static String annotationName(AnnotationTree annotation, Set<String> imports) {
    String written = annotation.getAnnotationType().toString();
    if (written.contains(".")) return written;
    for (String imported : imports) {
      if (imported.equals(written) || imported.endsWith("." + written)) return imported;
      if (imported.endsWith(".*")) {
        String candidate = imported.substring(0, imported.length() - 1) + written;
        if (candidate.equals(TEST) || candidate.equals(TAG)
            || UNSUPPORTED.contains(candidate) || LIFECYCLE.contains(candidate)) return candidate;
      }
    }
    return written;
  }

  private static String literalTag(AnnotationTree annotation) {
    if (annotation.getArguments().size() != 1) return null;
    ExpressionTree argument = annotation.getArguments().get(0);
    if (argument instanceof AssignmentTree) {
      AssignmentTree assignment = (AssignmentTree) argument;
      if (!assignment.getVariable().toString().equals("value")) return null;
      argument = assignment.getExpression();
    }
    if (!(argument instanceof LiteralTree) || !(((LiteralTree) argument).getValue() instanceof String)) return null;
    LiteralTree literal = (LiteralTree) argument;
    return (String) literal.getValue();
  }

  private static List<Declaration> parse(
    Path root, String relative, Path source, JavaCompiler compiler
  ) throws IOException {
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
        return List.of();
      }
      CompilationUnitTree unit = parsed.get(0);
      Set<String> imports = imports(unit);
      if (imports.stream().anyMatch(name -> name.endsWith(".*"))) {
        gap(relative, "UNSUPPORTED_JUNIT5_SOURCE_SHAPE");
        return List.of();
      }
      String packageName = unit.getPackageName() == null ? "" : unit.getPackageName().toString();
      if (packageName.isEmpty()) {
        gap(relative, "JAVA_PACKAGE_IDENTITY_UNAVAILABLE");
        return List.of();
      }
      Trees trees = Trees.instance(task);
      SourcePositions positions = trees.getSourcePositions();
      List<Declaration> declarations = new ArrayList<>();
      int[] classDepth = {0};
      int[] classCount = {0};
      boolean[] unsupported = {false};
      new TreePathScanner<Void, Void>() {
        @Override public Void visitClass(ClassTree node, Void unused) {
          classDepth[0] += 1;
          classCount[0] += 1;
          if (classDepth[0] > 1) unsupported[0] = true;
          for (AnnotationTree annotation : node.getModifiers().getAnnotations()) {
            String name = annotationName(annotation, imports);
            if (UNSUPPORTED.contains(name) || LIFECYCLE.contains(name)) unsupported[0] = true;
          }
          Void result = super.visitClass(node, unused);
          classDepth[0] -= 1;
          return result;
        }

        @Override public Void visitMethod(MethodTree node, Void unused) {
          if (classDepth[0] != 1) return super.visitMethod(node, unused);
          boolean test = false;
          List<String> clauses = new ArrayList<>();
          boolean methodUnsupported = false;
          for (AnnotationTree annotation : node.getModifiers().getAnnotations()) {
            String name = annotationName(annotation, imports);
            if (name.equals(TEST)) test = true;
            if (UNSUPPORTED.contains(name) || LIFECYCLE.contains(name)) methodUnsupported = true;
            if (name.equals(TAG)) {
              String tag = literalTag(annotation);
              if (tag == null) methodUnsupported = true;
              else if (tag.startsWith("sflow-ac:")) clauses.add(tag.substring("sflow-ac:".length()));
            }
          }
          if (!test && !methodUnsupported) return super.visitMethod(node, unused);
          if (methodUnsupported || node.getBody() == null || !node.getParameters().isEmpty()
              || node.getReturnType() == null || !node.getReturnType().toString().equals("void")
              || node.getModifiers().getFlags().contains(Modifier.ABSTRACT)) {
            unsupported[0] = true;
            return super.visitMethod(node, unused);
          }
          if (clauses.isEmpty()) return super.visitMethod(node, unused);
          if (new HashSet<>(clauses).size() != clauses.size()) {
            unsupported[0] = true;
            return super.visitMethod(node, unused);
          }
          long start = positions.getStartPosition(unit, node);
          long end = positions.getEndPosition(unit, node);
          Tree parent = getCurrentPath().getParentPath().getLeaf();
          if (!(parent instanceof ClassTree) || start < 0 || end <= start) {
            unsupported[0] = true;
            return super.visitMethod(node, unused);
          }
          ClassTree owner = (ClassTree) parent;
          declarations.add(new Declaration(
            relative, packageName, owner.getSimpleName().toString(), node.getName().toString(),
            "()void", start, end, clauses.stream().sorted().collect(Collectors.toList())
          ));
          return super.visitMethod(node, unused);
        }
      }.scan(unit, null);
      if (classCount[0] != 1 || unsupported[0]) {
        gap(relative, "UNSUPPORTED_JUNIT5_SOURCE_SHAPE");
        return List.of();
      }
      return declarations;
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
    List<Declaration> declarations = new ArrayList<>();
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
      declarations.addAll(parse(root, relative, source, compiler));
      if (declarations.size() > MAX_DECLARATIONS) {
        throw new IllegalArgumentException("declaration count exceeds " + MAX_DECLARATIONS);
      }
    }
    declarations.stream().sorted(Comparator.comparing(Declaration::path)
      .thenComparing(Declaration::className).thenComparing(Declaration::methodName))
      .forEach(WelJunitCatalog::declaration);
  }
}
