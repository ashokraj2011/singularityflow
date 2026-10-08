package com.acme.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query

@Dao
interface NoteDao {
    @Query("SELECT * FROM notes")
    fun all(): List<NoteEntity>

    @Insert
    fun insert(note: NoteEntity)
}

class NotesRepository(private val dao: NoteDao, private val api: NotesApi) {
    fun save(note: NoteEntity) {
        dao.insert(note)
    }

    fun delete(note: NoteEntity) {
        // Deletion is remote-first.
    }
}
