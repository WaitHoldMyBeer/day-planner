"""Tests for bin/tell. Run: python3 -m unittest discover -s routine/tests"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

TELL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "tell")


class TellCase(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="tell-test-")
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        self.path = os.path.join(self.home, "feedback.md")

    def tell(self, *args, stdin=None):
        return subprocess.run([sys.executable, TELL, *args], capture_output=True, text=True, input=stdin,
                              env={**os.environ, "BP_HOME": self.home})

    def read(self):
        with open(self.path, encoding="utf-8") as f:
            return f.read()

    def test_first_message_creates_the_file(self):
        p = self.tell("The syllabus says there is a survey before every lecture.")
        self.assertEqual(p.returncode, 0, p.stderr)
        text = self.read()
        new, handled = text.split("## Handled")
        self.assertIn("> The syllabus says there is a survey before every lecture.", new)
        self.assertRegex(new, r"### \d{4}-\d{2}-\d{2} \d{2}:\d{2}")
        self.assertEqual(handled.strip(), "")

    def test_messages_stay_in_order_and_above_handled(self):
        self.tell("first")
        with open(self.path, "a", encoding="utf-8") as f:
            f.write("\n### 2026-09-01 08:00\n\n> an old one\n\n2026-09-02: lesson L-003 added.\n")
        self.tell("second")
        text = self.read()
        new, handled = text.split("## Handled")
        self.assertLess(new.index("> first"), new.index("> second"))
        self.assertIn("> an old one", handled)
        self.assertNotIn("> second", handled)

    def test_message_from_the_terminal_keeps_its_lines(self):
        p = self.tell(stdin="line one\nline two\n")
        self.assertEqual(p.returncode, 0)
        self.assertIn("> line one\n> line two\n", self.read())

    def test_an_empty_message_changes_nothing(self):
        p = self.tell(stdin="  \n")
        self.assertEqual(p.returncode, 2)
        self.assertFalse(os.path.exists(self.path))

    def test_a_file_without_headings_gets_them_and_keeps_its_text(self):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("notes I wrote by hand\n")
        self.tell("hello")
        text = self.read()
        self.assertIn("notes I wrote by hand", text)
        self.assertLess(text.index("## New"), text.index("> hello"))
        self.assertLess(text.index("> hello"), text.index("## Handled"))

    def test_list(self):
        self.tell("something to list")
        p = self.tell("--list")
        self.assertIn("> something to list", p.stdout)


if __name__ == "__main__":
    unittest.main()
