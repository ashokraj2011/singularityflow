/*
 * Java call resolver for Singularity Flow's Java semantic AST pack.
 *
 * Parses and attributes the requested sources with the JDK's own compiler (javax.tools and the
 * com.sun.source tree API) and reports, for each method call, constructor call and method reference
 * inside a method or constructor, the declaration the compiler resolved it to. Source is read as
 * data: nothing is written to disk, no annotation processor runs and no repository class is loaded
 * or executed. Referenced classes are completed from the listed source roots only. The class path is
 * empty, so a call into a library resolves to nothing and is left out.
 *
 * Input (stdin, UTF-8, one record per line, paths relative to the working directory):
 *   source<TAB><path>   a file to analyze
 *   root<TAB><path>     a source root that referenced classes are completed from
 * Output (stdout), tab-separated, one line per record:
 *   call, caller path, caller name, caller line, target path, target name, target line,
 *     site start line, site start column, site end line, site end column
 *     (one per caller and callee, at its first call)
 *   override, method path, method name, method line, overridden path, overridden name,
 *     overridden line, name start line, name start column, name end line, name end column
 *     (one per repository method a declaration overrides or implements, at any depth)
 * A declaration's line is the line of its name; a constructor is named after its class. A call
 * through an interface or base class names the declared method: which override runs is decided at
 * run time (dependency injection, for one), so the overrides are reported beside the calls.
 */
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.NestingKind;
import javax.lang.model.element.TypeElement;
import javax.lang.model.type.TypeMirror;
import javax.lang.model.util.Elements;
import javax.lang.model.util.Types;
import javax.tools.Diagnostic;
import javax.tools.JavaCompiler;
import javax.tools.StandardJavaFileManager;
import javax.tools.StandardLocation;
import javax.tools.ToolProvider;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.MemberReferenceTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.TypeParameterTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;

final class JavaCallResolver {
  private static final class Declaration {
    final String path;
    final String name;
    final long line;
    final long column;

    Declaration(String path, String name, long line, long column) {
      this.path = path;
      this.name = name;
      this.line = line;
      this.column = column;
    }

    String key() {
      return path + '\0' + name + '\0' + line;
    }
  }

  private final Path base = Paths.get("").toAbsolutePath().normalize();
  private final Map<CompilationUnitTree, String> texts = new HashMap<>();
  private final Set<String> emitted = new HashSet<>();
  private Trees trees;
  private Elements elements;
  private Types types;
  private SourcePositions positions;
  private PrintWriter out;

  public static void main(String[] args) throws IOException {
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    if (compiler == null) {
      System.err.println("The JDK compiler is unavailable; a JDK (not a JRE) is required.");
      System.exit(3);
    }
    List<File> sources = new ArrayList<>();
    List<File> roots = new ArrayList<>();
    BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    for (String line = reader.readLine(); line != null; line = reader.readLine()) {
      int tab = line.indexOf('\t');
      if (tab < 0) continue;
      File file = new File(line.substring(tab + 1));
      if (line.startsWith("source\t") && file.isFile()) sources.add(file);
      else if (line.startsWith("root\t") && file.isDirectory()) roots.add(file);
    }
    new JavaCallResolver().run(compiler, sources, roots);
  }

  private void run(JavaCompiler compiler, List<File> sources, List<File> roots) throws IOException {
    StandardJavaFileManager manager = compiler.getStandardFileManager(null, Locale.ROOT, StandardCharsets.UTF_8);
    manager.setLocation(StandardLocation.CLASS_PATH, Collections.emptyList());
    manager.setLocation(StandardLocation.ANNOTATION_PROCESSOR_PATH, Collections.emptyList());
    manager.setLocation(StandardLocation.SOURCE_PATH, roots);
    // Keep attributing after errors: library types are missing by design, and every call that
    // can still be resolved against repository source is wanted.
    List<String> options = Arrays.asList("-proc:none", "-implicit:none", "-nowarn", "-Xlint:none", "-XDshould-stop.ifError=FLOW");
    JavacTask task = (JavacTask) compiler.getTask(null, manager, diagnostic -> { }, options, null,
      manager.getJavaFileObjectsFromFiles(sources));
    List<CompilationUnitTree> units = new ArrayList<>();
    for (CompilationUnitTree unit : task.parse()) units.add(unit);
    try {
      task.analyze();
    } catch (RuntimeException | StackOverflowError ignored) {
      // Report what was attributed before the compiler stopped.
    }
    trees = Trees.instance(task);
    elements = task.getElements();
    types = task.getTypes();
    positions = trees.getSourcePositions();
    out = new PrintWriter(new BufferedWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8)));
    for (CompilationUnitTree unit : units) {
      try {
        new Scanner().scan(unit, null);
      } catch (RuntimeException | StackOverflowError ignored) {
        // One file the compiler could not model costs only that file's edges.
      }
    }
    out.flush();
  }

  private final class Scanner extends TreePathScanner<Void, Declaration> {
    @Override
    public Void visitClass(ClassTree node, Declaration owner) {
      // A nested or anonymous class's own initializers are not part of the enclosing method.
      return super.visitClass(node, null);
    }

    @Override
    public Void visitMethod(MethodTree node, Declaration owner) {
      Element element = trees.getElement(getCurrentPath());
      Declaration self = element instanceof ExecutableElement && elements.getOrigin(element) == Elements.Origin.EXPLICIT
        ? declaration(getCurrentPath().getCompilationUnit(), node, element) : null;
      if (self != null && element.getKind() == ElementKind.METHOD) overrides(self, (ExecutableElement) element);
      return super.visitMethod(node, self);
    }

    @Override
    public Void visitMethodInvocation(MethodInvocationTree node, Declaration owner) {
      record(owner, node);
      return super.visitMethodInvocation(node, owner);
    }

    @Override
    public Void visitNewClass(NewClassTree node, Declaration owner) {
      record(owner, node);
      return super.visitNewClass(node, owner);
    }

    @Override
    public Void visitMemberReference(MemberReferenceTree node, Declaration owner) {
      record(owner, node);
      return super.visitMemberReference(node, owner);
    }

    private void record(Declaration owner, Tree node) {
      if (owner == null) return;
      CompilationUnitTree unit = getCurrentPath().getCompilationUnit();
      long start = positions.getStartPosition(unit, node);
      long end = positions.getEndPosition(unit, node);
      // A call the compiler inserted (an implicit super()) has no source text of its own.
      if (start == Diagnostic.NOPOS || end == Diagnostic.NOPOS) return;
      Declaration target = target(trees.getElement(getCurrentPath()));
      if (target == null || target.key().equals(owner.key())) return;
      if (!emitted.add(owner.key() + '\0' + target.key())) return;
      out.print("call\t" + owner.path + '\t' + owner.name + '\t' + owner.line + '\t'
        + target.path + '\t' + target.name + '\t' + target.line + '\t'
        + unit.getLineMap().getLineNumber(start) + '\t' + unit.getLineMap().getColumnNumber(start) + '\t'
        + unit.getLineMap().getLineNumber(end) + '\t' + unit.getLineMap().getColumnNumber(end) + '\n');
    }
  }

  /** Report each repository method that `method` overrides or implements, through any supertype. */
  private void overrides(Declaration self, ExecutableElement method) {
    if (!(method.getEnclosingElement() instanceof TypeElement)) return;
    TypeElement owner = (TypeElement) method.getEnclosingElement();
    Set<TypeElement> visited = new HashSet<>();
    Deque<TypeMirror> pending = new ArrayDeque<>(types.directSupertypes(owner.asType()));
    while (!pending.isEmpty() && visited.size() < 500) {
      Element element = types.asElement(pending.removeFirst());
      if (!(element instanceof TypeElement) || !visited.add((TypeElement) element)) continue;
      pending.addAll(types.directSupertypes(element.asType()));
      for (Element member : element.getEnclosedElements()) {
        if (member.getKind() != ElementKind.METHOD || !member.getSimpleName().contentEquals(method.getSimpleName())
            || !elements.overrides(method, (ExecutableElement) member, owner)) continue;
        Declaration overridden = target(member);
        if (overridden == null || !emitted.add("override\0" + self.key() + '\0' + overridden.key())) continue;
        out.print("override\t" + self.path + '\t' + self.name + '\t' + self.line + '\t'
          + overridden.path + '\t' + overridden.name + '\t' + overridden.line + '\t'
          + self.line + '\t' + self.column + '\t' + self.line + '\t' + (self.column + self.name.length()) + '\n');
      }
    }
  }

  /** The repository declaration a call resolves to, or null for library and synthetic members. */
  private Declaration target(Element element) {
    if (!(element instanceof ExecutableElement)) return null;
    Element declared = element;
    if (elements.getOrigin(element) != Elements.Origin.EXPLICIT) {
      // A default or record constructor is written nowhere; `new Cart()` then names the class.
      if (element.getKind() != ElementKind.CONSTRUCTOR) return null;
      declared = element.getEnclosingElement();
    }
    Element type = declared instanceof TypeElement ? declared : declared.getEnclosingElement();
    if (!(type instanceof TypeElement) || ((TypeElement) type).getNestingKind() == NestingKind.ANONYMOUS
        || ((TypeElement) type).getNestingKind() == NestingKind.LOCAL) return null;
    TreePath path = trees.getPath(declared);
    return path == null ? null : declaration(path.getCompilationUnit(), path.getLeaf(), declared);
  }

  private Declaration declaration(CompilationUnitTree unit, Tree tree, Element element) {
    String relative = relativePath(unit.getSourceFile().toUri());
    if (relative == null) return null;
    String name = element.getKind() == ElementKind.CONSTRUCTOR
      ? element.getEnclosingElement().getSimpleName().toString()
      : element.getSimpleName().toString();
    if (name.isEmpty()) return null;
    long offset = nameOffset(unit, tree, name);
    return offset < 0 ? null
      : new Declaration(relative, name, unit.getLineMap().getLineNumber(offset), unit.getLineMap().getColumnNumber(offset));
  }

  private String relativePath(URI uri) {
    if (!"file".equals(uri.getScheme())) return null;
    Path relative = base.relativize(Paths.get(uri).toAbsolutePath().normalize());
    String value = relative.toString().replace(File.separatorChar, '/');
    if (value.isEmpty() || value.startsWith("../") || value.equals("..") || relative.isAbsolute()
        || value.indexOf('\t') >= 0 || value.indexOf('\n') >= 0) return null;
    return value;
  }

  /** Offset of a declaration's name: the first occurrence after its modifiers and return type. */
  private long nameOffset(CompilationUnitTree unit, Tree tree, String name) {
    long start = positions.getStartPosition(unit, tree);
    if (start == Diagnostic.NOPOS) return -1;
    long from = start;
    if (tree instanceof MethodTree) {
      MethodTree method = (MethodTree) tree;
      from = Math.max(from, positions.getEndPosition(unit, method.getModifiers()));
      for (TypeParameterTree parameter : method.getTypeParameters()) from = Math.max(from, positions.getEndPosition(unit, parameter));
      if (method.getReturnType() != null) from = Math.max(from, positions.getEndPosition(unit, method.getReturnType()));
    } else if (tree instanceof ClassTree) {
      from = Math.max(from, positions.getEndPosition(unit, ((ClassTree) tree).getModifiers()));
    }
    String text = texts.computeIfAbsent(unit, (key) -> {
      try {
        return key.getSourceFile().getCharContent(true).toString();
      } catch (IOException error) {
        return "";
      }
    });
    for (int index = (int) from; index >= 0 && index + name.length() <= text.length(); index += 1) {
      if (index > 0 && Character.isJavaIdentifierPart(text.charAt(index - 1))) continue;
      if (!text.startsWith(name, index)) continue;
      int after = index + name.length();
      if (after < text.length() && Character.isJavaIdentifierPart(text.charAt(after))) continue;
      return index;
    }
    return start;
  }
}
