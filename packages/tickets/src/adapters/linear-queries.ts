/** GraphQL documents used by LinearTicketStore. Kept static: values only travel as variables. */

export const ISSUE_FIELDS = `
fragment MatrixIssue on Issue {
  id identifier title description url createdAt updatedAt priority
  state { id name type }
  team { id key }
  labels(first: 100) { nodes { id name } }
  assignee { name displayName email }
  parent { identifier }
  inverseRelations(first: 100) {
    nodes { id type issue { identifier state { type } } }
  }
}`;

export const LIST_ISSUES = `${ISSUE_FIELDS}
query MatrixIssues($filter: IssueFilter!, $after: String) {
  issues(first: 100, after: $after, filter: $filter, includeArchived: false) {
    nodes { ...MatrixIssue }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const GET_ISSUE = `${ISSUE_FIELDS}
query MatrixIssue($id: String!) { issue(id: $id) { ...MatrixIssue } }`;

export const TEAM = `
query MatrixTeam($key: String!) {
  teams(first: 2, filter: { key: { eq: $key } }) {
    nodes { id key states(first: 100) { nodes { id name type } } }
  }
}`;

export const LABELS = `
query MatrixLabels($names: [String!]!, $after: String) {
  issueLabels(first: 100, after: $after, filter: { name: { in: $names } }) {
    nodes { id name team { id } }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const CREATE_LABEL = `
mutation MatrixLabelCreate($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) { success issueLabel { id name team { id } } }
}`;

export const CREATE_ISSUE = `${ISSUE_FIELDS}
mutation MatrixIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ...MatrixIssue } }
}`;

export const UPDATE_ISSUE = `${ISSUE_FIELDS}
mutation MatrixIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { ...MatrixIssue } }
}`;

export const CREATE_COMMENT = `
mutation MatrixComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id } }
}`;

export const COMMENT = `
query MatrixCommentLookup($id: String!) {
  comment(id: $id) { id issue { id } user { id isMe } }
}`;

export const ISSUE_COMMENTS = `
query MatrixIssueComments($id: String!) {
  issue(id: $id) {
    comments(first: 100) { nodes { id body createdAt user { id isMe displayName name } } }
  }
}`;

export const VIEWER = `
query MatrixViewer { viewer { id app } }`;

/** Recent state changes of one issue, to tell a human's move from Matrix's own. */
export const ISSUE_HISTORY = `
query MatrixIssueHistory($id: String!) {
  issue(id: $id) {
    history(first: 100, orderBy: createdAt) {
      nodes { createdAt actor { id } botActor { id } fromState { name } toState { name } }
    }
  }
}`;

export interface LinearHistoryNode {
  createdAt: string;
  actor: { id: string } | null;
  botActor: { id: string } | null;
  fromState: { name: string } | null;
  toState: { name: string } | null;
}

export const UPDATE_COMMENT = `
mutation MatrixCommentUpdate($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) { success }
}`;

export const ADD_LABEL = `
mutation MatrixIssueAddLabel($id: String!, $labelId: String!) {
  issueAddLabel(id: $id, labelId: $labelId) { success }
}`;

export const REMOVE_LABEL = `
mutation MatrixIssueRemoveLabel($id: String!, $labelId: String!) {
  issueRemoveLabel(id: $id, labelId: $labelId) { success }
}`;

export const CREATE_RELATION = `
mutation MatrixRelation($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success }
}`;

export const DELETE_RELATION = `
mutation MatrixRelationDelete($id: String!) { issueRelationDelete(id: $id) { success } }`;

export const USERS = `
query MatrixUsers($q: String!) {
  users(first: 2, filter: { or: [
    { displayName: { eq: $q } }, { email: { eq: $q } }, { name: { eq: $q } }
  ] }) { nodes { id } }
}`;

export interface LinearState {
  id: string;
  name: string;
  type: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  priority: number;
  state: LinearState;
  team: { id: string; key: string };
  labels: { nodes: Array<{ id: string; name: string }> };
  assignee: { name: string; displayName: string; email: string } | null;
  parent: { identifier: string } | null;
  inverseRelations: {
    nodes: Array<{
      id: string;
      type: string;
      issue: { identifier: string; state: { type: string } };
    }>;
  };
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}
