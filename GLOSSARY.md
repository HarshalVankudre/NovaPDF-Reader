# NovaPDF Reader

A personal lecture-slide reader with document search and document-grounded tutoring.

## Language

**Document**:
A PDF of lecture slides that the owner reads, searches, and asks questions about.
_Avoid_: Upload (when referring to the document itself).

**Page**:
A numbered part of a document. Page 12 in one document is distinct from page 12 in another.
_Avoid_: Global page (across independent documents).

**Subject**:
A course or study topic covered by one or more lecture documents.
_Avoid_: Lecture (when referring to the entire subject).

**Active subject**:
The subject selected for reading, search, and tutoring. Its lecture documents are the scope of search results and tutor context.
_Avoid_: Workspace, tenant.

**Slide number**:
A number identifying a slide within one subject's lecture set. The same number in another subject refers to a different slide.
_Avoid_: Global page (without a subject).

**Owner**:
The person who uses and maintains their personal lecture reader and its document collection.
_Avoid_: Subscriber, team member.
