package com.acme.data

import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path

interface NotesApi {
    @GET("notes")
    suspend fun list(): List<NoteEntity>

    @POST("notes")
    suspend fun create(@Body note: NoteEntity): NoteEntity

    @DELETE("notes/{id}")
    suspend fun remove(@Path("id") id: Long)
}
