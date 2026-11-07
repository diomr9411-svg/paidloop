"""Runs the official EN 16931 rules in its own process.

The Saxon engine can crash the whole program when called from a web server's worker threads, so it
lives here on its main thread. If it ever dies, the app simply starts it again.

Protocol: read a line with a byte count, then that many bytes of XML. Write one line of JSON back.
"""

import json
import sys
from pathlib import Path

from lxml import etree
from saxonche import PySaxonProcessor

RULES_FILE = Path(__file__).parent / "rules" / "EN16931-CII-validation.xslt"
SVRL = {"svrl": "http://purl.oclc.org/dsdl/svrl"}


def check(processor, executable, xml: bytes) -> dict:
    node = processor.parse_xml(xml_text=xml.decode("utf-8"))
    report = etree.fromstring(executable.transform_to_string(xdm_node=node).encode("utf-8"))
    problems = []
    for failed in report.findall("svrl:failed-assert", SVRL):
        if failed.get("flag", "fatal") == "fatal":
            message = failed.findtext("svrl:text", namespaces=SVRL) or ""
            problems.append(f"{failed.get('id')}: {message.strip()}")
    return {"problems": problems, "checked": len(report.findall("svrl:fired-rule", SVRL))}


def main() -> None:
    with PySaxonProcessor(license=False) as processor:
        executable = processor.new_xslt30_processor().compile_stylesheet(stylesheet_file=str(RULES_FILE))
        while True:
            header = sys.stdin.buffer.readline()
            if not header:
                return
            xml = sys.stdin.buffer.read(int(header))
            try:
                answer = check(processor, executable, xml)
            except Exception as error:  # a broken document must give an answer, not end the worker
                answer = {"problems": [f"Rules could not read this document: {type(error).__name__}"], "checked": 0}
            sys.stdout.write(json.dumps(answer) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
