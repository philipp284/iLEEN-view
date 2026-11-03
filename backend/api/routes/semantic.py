"""
Semantic-Endpunkt: Vektorsuche + Volltext im LanceDB-Index.
"""

from fastapi import APIRouter, Query
from pydantic import BaseModel

from semantic.extractor import search_semantic, search_vector

router = APIRouter()


class SearchResult(BaseModel):
    doc_id: str
    job_id: str
    filename: str
    score: float
    excerpt: str


@router.get("/search", response_model=list[SearchResult])
async def fulltext_search(q: str = Query(..., min_length=2)):
    return await search_semantic(q)


@router.get("/vector", response_model=list[SearchResult])
async def vector_search(q: str = Query(..., min_length=2), limit: int = 10):
    return await search_vector(q, limit=limit)
