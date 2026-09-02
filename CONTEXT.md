# Code Factory

The Code Factory is the project context for turning software-engineering requests into verified repository outcomes across issues, pull requests, and explicit operator requests.

## Language

**Code Factory**:
The whole system that triages, investigates, changes, and reviews software repositories through governed automated runs.
_Avoid_: PR review agent, review bot, or fix bot when referring to the whole product

**Capability**:
A bounded kind of engineering work the Code Factory can perform, such as issue triage, bug investigation, bug fixing, feature implementation, or pull-request review.
_Avoid_: Agent type, bot

**Work Item**:
A repository-scoped request for an outcome, originating from an issue, pull request, or explicit operator request.
_Avoid_: Prompt, job

**Run**:
One traceable attempt by the Code Factory to advance a Work Item through one or more capabilities.
_Avoid_: Session, invocation
